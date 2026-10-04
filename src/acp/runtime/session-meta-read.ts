import {
  withSessionEntryReadOnlyInWorker,
  type SessionEntryReadWorkerOwner,
} from "../../config/sessions/session-entry-read-runtime.js";
import type { IncognitoSessionAuthority } from "../../config/sessions/session-incognito-contract.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import {
  captureAcpSessionReadContext,
  type AcpSessionReadContextInput,
} from "./session-meta-read-context.js";
import {
  readAcpSessionMetaForEntries,
  readAcpSessionMetaForEntry,
} from "./session-meta-readonly.js";
import {
  readSessionEntryFromStore,
  resolveSessionStorePathForAcp,
  type AcpSessionStoreEntry,
} from "./session-meta-store.js";

export type AcpSessionEntryReadInput = AcpSessionReadContextInput & {
  sessionKey: string;
  agentId?: string;
  clone?: boolean;
};

export type PreparedAcpSessionEntryRead = {
  session: AcpSessionStoreEntry | null;
  assertCurrent(this: void): void;
  release(): void;
};

export type AcpSessionEntryPreparer = (
  params: AcpSessionEntryReadInput,
) => Promise<PreparedAcpSessionEntryRead> | undefined;

/** Retain the canonical session source through its lifecycle-bound ACP metadata join. */
export async function readAcpSessionEntryAsync(
  params: AcpSessionEntryReadInput,
  incognito?: { actor: IncognitoAgentDatabaseExecution; authority: IncognitoSessionAuthority },
): Promise<AcpSessionStoreEntry | null> {
  const sessionKey = params.sessionKey.trim();
  // Empty keys share the reader's null result without opening a session store.
  if (!incognito || !sessionKey) {
    return withAcpSessionEntryRead(params, (entry) => entry);
  }
  const prepared = await prepareIncognitoAcpSessionEntryRead(params, incognito);
  try {
    prepared.assertCurrent();
    return prepared.session;
  } finally {
    prepared.release();
  }
}

/** Inactive cleanup composition; the prepared source remains owned until release. */
export async function prepareIncognitoAcpSessionEntryRead(
  params: AcpSessionEntryReadInput,
  incognito: { actor: IncognitoAgentDatabaseExecution; authority: IncognitoSessionAuthority },
): Promise<PreparedAcpSessionEntryRead> {
  const { actor, authority } = incognito;
  actor.assertCurrent();
  authority.assertCurrent();
  const input = { ...params, sessionKey: params.sessionKey.trim() };
  const context = captureAcpSessionReadContext(input);
  return actor.sessions.withSharedState(async () => {
    const captured = await context;
    const target = resolveSessionStorePathForAcp({ ...input, ...captured });
    if (target.agentId !== actor.agentId) {
      throw new Error("ACP read differs from its captured incognito actor");
    }
    const released = createDeferredCore();
    void actor.sessions.withSharedState(() => released.promise);
    let active = true;
    let changed = false;
    const unsubscribe = sessionChanges.subscribeFacts((change) => {
      if (
        "all" in change ||
        (change.sessionKey === target.storeSessionKey &&
          (!change.agentId || change.agentId === actor.agentId))
      ) {
        changed = true;
      }
    });
    const release = () => {
      active = false;
      unsubscribe();
      released.resolve();
    };
    try {
      const { prepareIncognitoAcpSessionEntry } = await import("./session-meta-worker-mutation.js");
      const prepared = await prepareIncognitoAcpSessionEntry({
        ...captured,
        actor,
        sessionKey: target.storeSessionKey,
        authority: {
          assertCurrent() {
            captured.assertCurrent();
            authority.assertCurrent();
          },
          authorize: (stage, facts) => authority.authorize?.(stage, facts),
        },
      });
      const assertCurrent = () => {
        // Shared ACP publication can follow its actor-entry commit; retain both fences.
        prepared.assertCurrent();
        if (!active || changed) {
          throw new Error("Prepared ACP session changed before binding cleanup");
        }
      };
      assertCurrent();
      return {
        session: {
          ...target,
          cfg: captured.cfg,
          sessionKey: input.sessionKey,
          entry: prepared.entry,
          acp: prepared.entry?.acp,
        },
        assertCurrent,
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  });
}

/** The consuming owner can verify the exact selected physical source before custody ends. */
export async function withAcpSessionEntryRead<T>(
  params: AcpSessionEntryReadInput,
  consume: (
    entry: AcpSessionStoreEntry | null,
    owner: SessionEntryReadWorkerOwner | undefined,
  ) => T | Promise<T>,
  options: { currentMetadata?: true } = {},
): Promise<T> {
  const input = { ...params };
  const sessionKey = input.sessionKey.trim();
  input.assertCurrent?.();
  if (!sessionKey) {
    return consume(null, undefined);
  }
  const { cfg, env, databasePath, assertCurrent } = await captureAcpSessionReadContext(input);
  assertCurrent();
  const target = resolveSessionStorePathForAcp({ ...input, sessionKey, cfg, env });
  const storeSessionKey = normalizeStoreSessionKey(target.storeSessionKey);
  if (isIncognitoSessionKey(storeSessionKey)) {
    // Incognito retains its process-held native owner and nonyielding join until its cutover.
    const stored = readSessionEntryFromStore({ ...input, sessionKey, cfg, env });
    const acp = readAcpSessionMetaForEntry(
      {
        sessionKey: stored.storeSessionKey,
        agentId: stored.agentId,
        cfg,
        entry: stored.entry,
        env,
        databasePath,
      },
      { current: options.currentMetadata },
    );
    assertCurrent();
    return consume(
      { ...target, ...stored, storePath: target.storePath, sessionKey, acp },
      { kind: "native", assertCurrent },
    );
  }
  return await withSessionEntryReadOnlyInWorker(
    { agentId: target.agentId, storePath: target.storePath, sessionKey: storeSessionKey, env },
    assertCurrent,
    async (read, owner) => {
      const entry = read.ok ? read.value : undefined;
      const [acp] = await readAcpSessionMetaForEntries(
        {
          entries: [{ sessionKey: storeSessionKey, agentId: target.agentId, entry }],
          cfg,
          env,
          databasePath,
        },
        { current: options.currentMetadata },
      );
      assertCurrent();
      return consume(
        {
          cfg,
          agentId: target.agentId,
          storePath: target.storePath,
          sessionKey,
          storeSessionKey,
          entry,
          acp: acp ?? undefined,
          ...(!read.ok ? { storeReadFailed: true } : {}),
        },
        owner,
      );
    },
  );
}

export async function readAcpSessionMetaAsync(
  params: AcpSessionEntryReadInput,
): Promise<SessionAcpMeta | undefined> {
  return (await readAcpSessionEntryAsync({ ...params, clone: false }))?.acp;
}
