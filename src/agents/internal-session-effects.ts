import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
/** Manages hidden sessions used for suppressed agent side effects. */
import {
  applySessionEntryLifecycleMutation,
  createSessionEntryWithTranscript,
  deleteSessionEntryLifecycle,
  forkSessionFromParentTranscript,
} from "../config/sessions/session-accessor.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
  withSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import { captureSessionEntryReadScope } from "../config/sessions/session-entry-read-request.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import type { AgentRunSessionTarget } from "./run-session-target.types.js";

export type InternalSessionEffectsTarget = InternalSessionEffectsSource & {
  sessionEntry: InternalSessionEntry;
  sessionFile: string;
};

type InternalSessionEffectsSource = Required<
  Pick<AgentRunSessionTarget, "agentId" | "sessionId" | "sessionKey" | "storePath">
>;

/** Resolves the deterministic storage target owned by one internal-effects run. */
function resolveInternalSessionEffectsTarget(params: {
  agentId: string;
  runId: string;
  storePath: string;
}): InternalSessionEffectsSource {
  const incognito =
    Boolean(captureSessionActorStorageOwner(params, { assertCurrent() {}, authorize() {} })) ||
    isIncognitoOpenClawAgentSqlitePath(params.storePath, { agentId: params.agentId });
  return {
    agentId: params.agentId,
    storePath: params.storePath,
    ...resolveInternalSessionEffectsIdentity({
      agentId: params.agentId,
      runId: params.runId,
      ...(incognito ? { incognito: true } : {}),
    }),
  };
}

function toInternalSessionEffectsTarget(
  scope: InternalSessionEffectsSource,
  entry: InternalSessionEntry,
): InternalSessionEffectsTarget {
  return {
    agentId: scope.agentId,
    sessionId: entry.sessionId,
    sessionKey: scope.sessionKey,
    storePath: scope.storePath,
    sessionEntry: entry,
    sessionFile: scope.sessionKey,
  };
}

/** Creates or reopens the hidden session owned by one internal-effects run. */
export async function prepareInternalSessionEffectsSession(params: {
  agentId: string;
  cwd?: string;
  runId: string;
  source?: InternalSessionEffectsSource;
  commitGuard?: () => void;
  storePath: string;
}): Promise<InternalSessionEffectsTarget> {
  params.commitGuard?.();
  const target = resolveInternalSessionEffectsTarget(params);
  const { env } = captureSessionEntryReadScope(target);
  const scope = { ...target, env };
  const authority = {
    assertCurrent() {
      params.commitGuard?.();
    },
    authorize() {},
  };
  const memory = captureSessionActorStorageOwner(scope, authority);
  const prepare = async () => {
    const existing = memory
      ? readCapturedSessionActorEntry(memory, scope.sessionKey)
      : await readSessionEntryReadOnlyInWorker(scope, params.commitGuard);
    params.commitGuard?.();
    if (existing?.sessionId === scope.sessionId) {
      return toInternalSessionEffectsTarget(scope, existing);
    }

    if (params.source) {
      await forkSessionFromParentTranscript({
        agentId: params.source.agentId,
        parentEntry: { sessionId: params.source.sessionId, updatedAt: Date.now() },
        parentSessionKey: params.source.sessionKey,
        sessionKey: scope.sessionKey,
        storePath: params.source.storePath,
        targetSessionId: scope.sessionId,
        targetStorePath: params.storePath,
        commitGuard: params.commitGuard,
      });
    }
    const now = Date.now();
    const created = await createSessionEntryWithTranscript(
      scope,
      () => ({
        ok: true,
        entry: {
          ...buildSessionCreationStamp({ via: "internal", actor: { type: "system" } }),
          delivery: { kind: "internal" },
          sessionId: scope.sessionId,
          ...(isIncognitoSessionKey(scope.sessionKey) ? { incognito: true as const } : {}),
          sessionStartedAt: now,
          updatedAt: now,
        },
      }),
      { cwd: params.cwd, commitGuard: params.commitGuard },
    );
    if (!created.ok) {
      throw new Error(`Failed to create internal session for run ${params.runId}`);
    }
    return toInternalSessionEffectsTarget(scope, created.entry);
  };
  if (!memory) {
    return prepare();
  }
  const result = await withSessionActorStorage(
    scope,
    {
      authority,
      lifetime: {
        assertCurrent: () => authority.assertCurrent(),
        assertReadable: () => authority.assertCurrent(),
      },
      create: true,
    },
    prepare,
  );
  if (!result) {
    throw new Error("Internal memory session could not be acquired");
  }
  return result;
}

/** Tracks every hidden binding used by one run, including accepted compaction rotations. */
export function createInternalSessionEffectsCleanup(params: {
  enabled: boolean;
  agentId: string;
  runId: string;
  storePath?: string;
  onError: (error: unknown) => void;
}) {
  const targets = params.enabled ? new Map<string, AgentRunSessionTarget>() : undefined;
  const source =
    params.enabled && params.storePath
      ? captureSessionActorStorageOwner(params, { assertCurrent() {}, authorize() {} })
      : undefined;
  const track = (target: AgentRunSessionTarget | undefined) => {
    if (!targets || !target?.sessionKey || !target.storePath) {
      return;
    }
    targets.set(`${target.storePath}\n${target.sessionKey}`, target);
  };
  if (targets && params.storePath) {
    track(
      resolveInternalSessionEffectsTarget({
        agentId: params.agentId,
        runId: params.runId,
        storePath: params.storePath,
      }),
    );
  }
  const cleanup = async () => {
    if (!targets) {
      return;
    }
    // Compaction may rotate a private session identity. Remove every owned
    // session only after delivery; transcript and trajectory rows cascade.
    for (const target of targets.values()) {
      try {
        await removeInternalSessionEffectsSession(target);
      } catch (error) {
        // Cleanup remains best-effort so a terminal write failure does
        // not replace the completed model-run result.
        params.onError(error);
      }
    }
  };
  return {
    track,
    cleanup: async () => {
      if (source && !source.owner && !source.binding) {
        return;
      }
      source?.owner?.assertCurrent();
      await cleanup();
    },
  };
}

/** Hard-deletes a run-owned hidden session and its transcript rows. */
export async function removeInternalSessionEffectsSession(
  target: AgentRunSessionTarget | undefined,
  expectedOwner?: Pick<InternalSessionEntry, "lifecycleRevision" | "activeWriterRunId">,
): Promise<void> {
  if (!target?.sessionKey || !target.storePath) {
    return;
  }
  const source = captureSessionActorStorageOwner(target, { assertCurrent() {}, authorize() {} });
  const { env } = captureSessionEntryReadScope({ ...target, sessionKey: target.sessionKey });
  const scope = {
    ...(target.agentId ? { agentId: target.agentId } : {}),
    storePath: target.storePath,
    env,
  };
  const expectedEntry = expectedOwner
    ? source
      ? readCapturedSessionActorEntry(source, target.sessionKey)
      : await readSessionEntryReadOnlyInWorker({ ...scope, sessionKey: target.sessionKey })
    : undefined;
  if (
    expectedOwner &&
    (!expectedEntry ||
      expectedEntry.sessionId !== target.sessionId ||
      expectedEntry.lifecycleRevision !== expectedOwner.lifecycleRevision ||
      expectedEntry.activeWriterRunId !== expectedOwner.activeWriterRunId)
  ) {
    return;
  }
  if (source) {
    const sessionKey = target.sessionKey;
    await withSessionActorStorage(
      { ...scope, sessionKey },
      {
        authority: source.authority,
        lifetime: { assertCurrent() {}, assertReadable() {} },
      },
      () =>
        deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
          expectedSessionId: target.sessionId,
          expectedEntry,
        }),
    );
    return;
  }
  await applySessionEntryLifecycleMutation({
    ...scope,
    removals: [
      {
        sessionKey: target.sessionKey,
        ...(target.sessionId ? { expectedSessionId: target.sessionId } : {}),
        ...(expectedEntry ? { expectedEntry } : {}),
        archiveRemovedTranscript: false,
      },
    ],
    skipMaintenance: true,
  });
}
