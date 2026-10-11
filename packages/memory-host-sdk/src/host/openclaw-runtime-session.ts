// Session/runtime facade for memory transcript helpers.
import path from "node:path";
import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { cloneEnvWithPlatformSemantics } from "../../../../src/config/config-env-vars.js";
import {
  readTranscriptExportSnapshotReadOnlySync,
  readTranscriptStatsBatchReadOnlySync as readAccessorTranscriptStatsBatchReadOnlySync,
  readTranscriptStatsSync as readAccessorTranscriptStatsSync,
} from "../../../../src/config/sessions/session-accessor.js";
import { getSessionActorStorageBinding } from "../../../../src/config/sessions/session-actor-storage-binding.js";
import {
  captureIncognitoSessionSource,
  captureIncognitoSessionHistoryBinding,
  withIncognitoSessionBinding,
} from "../../../../src/config/sessions/session-incognito-binding.js";
import { captureSessionTranscriptStorageEnvironment } from "../../../../src/config/sessions/transcript-target-binding.js";
import { IncognitoSessionSyncAccessError } from "../../../../src/state/incognito-session-error.js";

export { readAccessorTranscriptStatsSync as readTranscriptStatsSync };
export { readTranscriptExportSnapshotReadOnlySync };
export { readRestoredSessionTranscript } from "../../../../src/config/sessions/session-cold-storage-read.js";
export { SessionTranscriptColdError } from "../../../../src/config/sessions/session-cold-storage-state.js";
export {
  listSessionEntriesCore,
  listSessionEntriesReadOnly,
} from "../../../../src/config/sessions/session-accessor.js";
export { isIncognitoSessionKey } from "../../../../src/routing/session-key.js";
export { isIncognitoOpenClawAgentSqlitePath } from "../../../../src/state/openclaw-agent-db.paths.js";
export { cloneEnvWithPlatformSemantics };

/** Native sync compatibility stays available until production actor acquisition. */
export function assertBoundIncognitoMemorySyncAccess(
  scope: Parameters<typeof captureIncognitoSessionSource>[0],
  method: string,
  replacement: string,
) {
  if (
    getSessionActorStorageBinding({ agentId: scope?.agentId, storePath: scope?.storePath }) ||
    captureIncognitoSessionSource(scope)
  ) {
    throw new IncognitoSessionSyncAccessError(method, replacement);
  }
}

export function readTranscriptStatsBatchReadOnlySync(
  scopes: Parameters<typeof readAccessorTranscriptStatsBatchReadOnlySync>[0],
) {
  for (const scope of scopes) {
    assertBoundIncognitoMemorySyncAccess(
      scope,
      "readTranscriptStatsBatchReadOnlySync",
      "buildSessionEntry",
    );
  }
  return readAccessorTranscriptStatsBatchReadOnlySync(scopes);
}

/** Capture the physical source before loading the optional compute adapter. */
export function captureIncognitoMemoryReader(
  scope: Parameters<typeof captureIncognitoSessionHistoryBinding>[0],
) {
  const memory = getSessionActorStorageBinding({
    agentId: scope.agentId,
    storePath: scope.storePath,
  });
  if (memory) {
    const selectedId = scope.sessionId ?? scope.sessionEntry?.sessionId;
    const selectedKey = scope.sessionKey;
    const storage = memory.actor.storage!;
    const selection = { sessionId: selectedId, sessionKey: selectedKey };
    const assertDisclosure = (sessionId: string) => {
      const selected = storage.readCurrent(
        { type: "session.entry.readById", input: { sessionId } },
        memory.authority,
      );
      if (!selected) {
        throw new Error("Incognito Memory session is no longer available");
      }
    };
    return {
      async memoryEntry(
        absPath: string,
        options: import("./session-files.js").BuildSessionEntryOptions,
      ) {
        const { buildSessionEntryFromSnapshot } = await import("./session-files.js");
        const snapshot = await storage.read(
          {
            type: "session.memory.entry",
            input: { ...selection, includeMessages: Boolean(options.onTranscriptMessage) },
          },
          memory.authority,
        );
        if (!snapshot) {
          return null;
        }
        return buildSessionEntryFromSnapshot(
          absPath,
          {
            ...options,
            agentId: memory.agentId,
            storePath: memory.path,
            sessionId: snapshot.sessionId,
            sessionKey: snapshot.sessionKey,
          },
          snapshot,
          () => assertDisclosure(snapshot.sessionId),
        );
      },
      memoryResetRecall() {
        return storage.read(
          { type: "session.memory.resetRecall", input: selection },
          memory.authority,
        );
      },
    };
  }
  const shared = captureIncognitoSessionSource(scope);
  if (!shared) {
    return undefined;
  }
  if ("kind" in shared) {
    const readAbsent = <T>(value: T) =>
      Promise.resolve().then(() => {
        shared.assertCurrent();
        return value;
      });
    return {
      memoryEntry() {
        return readAbsent(null);
      },
      memoryResetRecall() {
        return readAbsent({ state: "invalid" as const });
      },
    };
  }
  const { actor, admissionSignal } = shared;
  const memorySessionId = scope.sessionId ?? scope.sessionEntry?.sessionId;
  const authority = {
    assertCurrent() {
      admissionSignal?.throwIfAborted();
      actor.assertReadable();
    },
  };
  const capture = (sessionKey: string) =>
    withIncognitoSessionBinding(shared, () => {
      const binding = captureIncognitoSessionHistoryBinding({
        agentId: actor.agentId,
        storePath: actor.path,
        sessionKey,
      });
      if (!binding) {
        throw new Error("Incognito Memory lost its captured binding");
      }
      return binding;
    });
  const currentKey =
    scope.sessionKey ??
    actor.sessions.deadlines().find((entry) => entry.sessionId === memorySessionId)?.sessionKey;
  const current =
    currentKey && actor.sessions.readSharing(currentKey)?.entry ? capture(currentKey) : undefined;
  const missingClaim =
    !current && currentKey ? actor.sessions.captureCurrent(currentKey) : undefined;
  const read = <T>(
    operation: (
      reader: ReturnType<
        typeof import("../../../../src/config/sessions/session-incognito-compute-read.js").bindIncognitoSessionComputeReader
      >,
    ) => Promise<T>,
    missing: T,
  ) => {
    let resolved = current;
    let selectedAbsent = false;
    let assertReadCurrent: (() => void) | undefined;
    const consume = async (binding: NonNullable<typeof current>, assertSource: () => void) => {
      const { bindIncognitoSessionComputeReader } =
        await import("../../../../src/config/sessions/session-incognito-compute-read.js");
      assertSource();
      return operation(
        bindIncognitoSessionComputeReader({
          ...binding,
          memorySessionId,
          onMemoryRead: (assertCurrent) => {
            assertReadCurrent = assertCurrent;
          },
          authority: {
            assertCurrent() {
              assertSource();
              binding.authority.assertCurrent();
            },
            authorize: (stage, facts) => binding.authority.authorize?.(stage, facts),
          },
        }),
      );
    };
    return actor.sessions
      .withSharedState(() =>
        current
          ? consume(current, () => current.authority.assertCurrent())
          : actor.sessions.withCompute(
              authority,
              undefined,
              async (compute) => {
                const inventory = await compute.execute({
                  type: "session.compute.store.inventory",
                  input: {},
                });
                compute.assertCurrent();
                missingClaim?.assertCurrent();
                const selected = inventory.find(
                  (entry) =>
                    entry.sessionId === memorySessionId &&
                    (!currentKey || entry.sessionKey === currentKey),
                );
                if (!selected) {
                  selectedAbsent = true;
                  return missing;
                }
                resolved = capture(selected.sessionKey);
                return consume(resolved, compute.assertCurrent);
              },
              admissionSignal,
            ),
      )
      .then((result) => {
        authority.assertCurrent();
        missingClaim?.assertCurrent();
        resolved?.authority.assertCurrent();
        assertReadCurrent?.();
        if (
          selectedAbsent &&
          actor.sessions
            .deadlines()
            .some(
              (entry) =>
                entry.sessionId === memorySessionId &&
                (!currentKey || entry.sessionKey === currentKey),
            )
        ) {
          throw new Error("Incognito Memory transcript appeared during preparation");
        }
        return result;
      });
  };
  return {
    memoryEntry(absPath: string, options: import("./session-files.js").BuildSessionEntryOptions) {
      const { onTranscriptMessage, ...serializable } = options;
      const captured = {
        ...structuredClone(serializable),
        storePath: actor.path,
        onTranscriptMessage,
      };
      return read((reader) => reader.memoryEntry(absPath, captured), null);
    },
    memoryResetRecall(input: {
      agentId: string;
      sessionId: string;
      sessionKey?: string;
      storePath: string;
    }) {
      const captured = { ...structuredClone(input), storePath: actor.path };
      return read((reader) => reader.memoryResetRecall(captured), { state: "invalid" });
    },
  };
}

/** Read the captured memory-only corpus without opening an absent actor. */
export function readBoundIncognitoMemoryCorpus(
  scope: import("./session-transcript-corpus.types.js").SessionTranscriptCorpusScope,
  options: import("./session-transcript-corpus.types.js").SessionTranscriptCorpusOptions,
) {
  const memory = getSessionActorStorageBinding({
    agentId: scope.normalizedAgentId,
    storePath: scope.storePath,
  });
  if (memory) {
    return memory.actor.storage!.read(
      { type: "session.corpus.list", input: { options } },
      memory.authority,
    );
  }
  const binding = captureIncognitoSessionSource({
    agentId: scope.normalizedAgentId,
    // Corpus discovery captures ambient env; the configured sentinel owns its physical root.
    storePath: scope.storePath,
  });
  if (!binding) {
    return undefined;
  }
  if ("kind" in binding) {
    return Promise.resolve().then(() => {
      binding.assertCurrent();
      return [];
    });
  }
  const selected = binding.actor.sessions.deadlines();
  const claims = new Map(
    selected.map(({ sessionKey }) => [
      sessionKey,
      binding.actor.sessions.captureCurrent(sessionKey),
    ]),
  );
  const assertSelection = () => {
    binding.admissionSignal?.throwIfAborted();
    binding.actor.assertReadable();
    const current = binding.actor.sessions.deadlines();
    if (
      current.length !== claims.size ||
      current.some(({ sessionKey }) => !claims.has(sessionKey))
    ) {
      throw new Error("Incognito Memory corpus changed during preparation");
    }
    for (const claim of claims.values()) {
      claim.assertCurrent();
    }
  };
  let assertReadCurrent: (() => void) | undefined;
  const disclose = <T>(value: T): T => {
    assertSelection();
    assertReadCurrent?.();
    return value;
  };
  assertSelection();
  const target = selected[0];
  if (!target) {
    return binding.actor.sessions
      .withCompute(
        { assertCurrent: assertSelection },
        undefined,
        async (compute) => {
          await compute.execute({ type: "session.compute.store.inventory", input: {} });
          return [];
        },
        binding.admissionSignal,
      )
      .then(disclose);
  }
  const history = captureIncognitoSessionHistoryBinding({
    agentId: scope.normalizedAgentId,
    storePath: scope.storePath,
    ...target,
  });
  if (!history) {
    throw new Error("Incognito Memory corpus lost its captured binding");
  }
  const captured = structuredClone({
    scope: { ...scope, env: captureSessionTranscriptStorageEnvironment(scope.env) },
    options,
  });
  return binding.actor.sessions
    .withSharedState(async () => {
      const { readIncognitoMemoryCorpus } =
        await import("../../../../src/config/sessions/session-incognito-memory-corpus.js");
      assertSelection();
      return readIncognitoMemoryCorpus(
        {
          ...history,
          authority: {
            assertCurrent() {
              assertSelection();
              history.authority.assertCurrent();
            },
            authorize: (stage, facts) => history.authority.authorize?.(stage, facts),
          },
        },
        captured.scope,
        captured.options,
        binding.admissionSignal,
        (assertCurrent) => {
          assertReadCurrent = assertCurrent;
        },
      );
    })
    .then(disclose);
}

/** Keep worker launch machinery behind the memory host's existing lazy runtime bridge. */
export async function prepareSessionEntryInWorker(
  ...args: Parameters<
    typeof import("../../../../src/config/sessions/session-transcript-read-worker-runtime.js").prepareSessionEntryInWorker
  >
) {
  const { prepareSessionEntryInWorker: prepare } =
    await import("../../../../src/config/sessions/session-transcript-read-worker-runtime.js");
  return prepare(...args);
}

export async function readSessionTranscriptCorpusInWorker(
  ...args: Parameters<
    typeof import("../../../../src/config/sessions/session-transcript-inventory-runtime.js").readSessionTranscriptCorpusInWorker
  >
) {
  const { readSessionTranscriptCorpusInWorker: read } =
    await import("../../../../src/config/sessions/session-transcript-inventory-runtime.js");
  return read(...args);
}

export { resolveSessionAgentId } from "../../../../src/agents/agent-scope.js";
export { stripInternalRuntimeContext } from "../../../../src/agents/internal-runtime-context.js";
export { isHeartbeatUserMessage } from "../../../../src/auto-reply/heartbeat-filter.js";
export { HEARTBEAT_PROMPT } from "../../../../src/auto-reply/heartbeat.js";
export { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
export {
  HEARTBEAT_TOKEN,
  SILENT_REPLY_TOKEN,
  isSilentReplyPayloadText,
} from "../../../../src/auto-reply/tokens.js";
export { getRuntimeConfig } from "../../../../src/config/config.js";
export {
  isCompactionCheckpointTranscriptFileName,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseUsageCountedSessionIdFromFileName,
} from "../../../../src/config/sessions/artifacts.js";
export { materializeSessionArchiveForRead } from "../../../../src/config/sessions/archive-compression.js";
export { canonicalizeMainSessionAlias } from "../../../../src/config/sessions/main-session.js";
export {
  listSessionTranscriptArchivesReadOnly,
  listSessionTranscriptInstances,
} from "../../../../src/config/sessions/session-history.js";
export { resolveSessionTranscriptsDirForAgent } from "../../../../src/config/sessions/paths.js";
export type { CanonicalSessionReaderContinuation } from "../../../../src/config/sessions/session-canonical-key.js";
export type { SessionEntry } from "../../../../src/config/sessions/types.js";
/** Historical command notices are runtime context, not user-authored memory. */
export function isExecCompletionEvent(event: string): boolean {
  const trimmed = event.trimStart();
  return (
    /^exec finished(?::|\s*\()/i.test(trimmed) ||
    /^exec (completed|failed) \(([a-z0-9_-]{1,64}), (code -?\d+|signal [^)]+)\)(?: :: ([\s\S]*))?$/i.test(
      trimmed,
    )
  );
}
export {
  parseSqliteSessionFileMarker,
  resolveStorePath,
} from "../../../../src/plugin-sdk/session-store-runtime.js";
export { hasInterSessionUserProvenance } from "../../../../src/sessions/input-provenance.js";
export { onSessionTranscriptUpdate } from "../../../../src/sessions/transcript-events.js";

/** Returns an opaque revision that changes for every canonical transcript mutation. */
export function readTranscriptContentRevisionSync(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): string {
  const stats = readAccessorTranscriptStatsSync(params);
  return [
    "sqlite",
    stats.maxSeq,
    stats.sizeBytes,
    stats.eventCount,
    stats.lastMutationAtMs ?? "",
    stats.lastObservedMutationAtMs ?? "",
  ].join(":");
}
/** Extracts the agent id from a canonical `agents/<id>/sessions` directory path. */
export function extractAgentIdFromSessionsDir(sessionsDir: string): string | null {
  const parts = path.normalize(path.resolve(sessionsDir)).split(path.sep).filter(Boolean);
  const sessionsSegment = parts.at(-1);
  const agentId = parts.at(-2);
  const agentsSegment = parts.at(-3);
  const isWindows = process.platform === "win32";
  // Windows preserves path casing while matching canonical segments without it.
  // Reject malformed ids before normalization to prevent cross-agent aliasing.
  if (
    !sessionsSegment ||
    !agentId ||
    !agentsSegment ||
    (isWindows ? sessionsSegment.toLowerCase() : sessionsSegment) !== "sessions" ||
    (isWindows ? agentsSegment.toLowerCase() : agentsSegment) !== "agents" ||
    (isWindows && (agentId !== agentId.trim() || !isValidAgentId(agentId)))
  ) {
    return null;
  }
  return isWindows ? normalizeAgentId(agentId) : agentId;
}

/** Finds the nearest canonical sessions owner without escaping its directory. */
export function extractAgentIdFromSessionPath(absPath: string): string | null {
  let currentDir = path.dirname(path.resolve(absPath));
  while (true) {
    const currentSegment = path.basename(currentDir);
    const isSessionsDir =
      (process.platform === "win32" ? currentSegment.toLowerCase() : currentSegment) === "sessions";
    if (isSessionsDir) {
      const agentId = extractAgentIdFromSessionsDir(currentDir);
      // Nested transcript folders may also be named `sessions`; only a
      // canonical agents/<id>/sessions ancestor establishes ownership.
      if (agentId) {
        return agentId;
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export {
  DREAMING_NARRATIVE_RUN_PREFIX,
  isDreamingNarrativeSessionStoreKey,
} from "./session-transcript-corpus-policy.js";

export async function readSessionResetRecallCutoffInWorker(
  ...args: Parameters<
    typeof import("../../../../src/config/sessions/session-transcript-read-worker-runtime.js").readSessionResetRecallCutoffInWorker
  >
) {
  const { readSessionResetRecallCutoffInWorker: read } =
    await import("../../../../src/config/sessions/session-transcript-read-worker-runtime.js");
  return read(...args);
}
