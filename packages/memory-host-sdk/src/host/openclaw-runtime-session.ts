// Session/runtime facade for memory transcript helpers.
import path from "node:path";
import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { cloneEnvWithPlatformSemantics } from "../../../../src/config/config-env-vars.js";
import {
  readTranscriptExportSnapshotReadOnlySync,
  readTranscriptStatsBatchReadOnlySync as readAccessorTranscriptStatsBatchReadOnlySync,
  readTranscriptStatsSync as readAccessorTranscriptStatsSync,
} from "../../../../src/config/sessions/session-accessor.js";
import type { SessionTranscriptReadScope } from "../../../../src/config/sessions/session-accessor.types.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "../../../../src/config/sessions/session-actor-storage-binding.js";
import { getAsyncWorkSignal } from "../../../../src/shared/async-work-scope.js";
import { IncognitoSessionSyncAccessError } from "../../../../src/state/incognito-session-error.js";

export { readAccessorTranscriptStatsSync as readTranscriptStatsSync };
export { readTranscriptExportSnapshotReadOnlySync };
export { readRestoredSessionTranscript } from "../../../../src/config/sessions/session-cold-storage-read.js";
export { SessionTranscriptColdError } from "../../../../src/config/sessions/session-cold-storage-state.js";
export {
  listSessionEntriesCore,
  listSessionEntriesReadOnly,
} from "../../../../src/config/sessions/session-accessor.js";
export { cloneEnvWithPlatformSemantics };

/** Synchronous SDK calls cannot open memory-only session storage. */
export function assertBoundIncognitoMemorySyncAccess(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "storePath" | "sessionKey">,
  method: string,
  replacement: string,
) {
  if (captureMemoryOwner(scope)) {
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

function captureMemoryOwner(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "storePath" | "sessionKey">,
) {
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => signal?.throwIfAborted();
  return captureSessionActorStorageOwner(scope, { assertCurrent, authorize: assertCurrent });
}

/** Capture the memory namespace once; reads never create a missing owner or session. */
export function captureIncognitoMemoryReader(scope: SessionTranscriptReadScope) {
  const namespace = captureMemoryOwner(scope);
  if (!namespace) {
    return undefined;
  }
  const selected = namespace.binding?.agentId === namespace.agentId ? namespace.binding : undefined;
  const read = async <T>(
    consume: (binding: SelectedSessionActorStorageBinding) => Promise<T>,
    missing: T,
  ): Promise<T> => {
    if (!namespace.owner && !selected) {
      namespace.authority.assertCurrent();
      return missing;
    }
    return (
      (await withSessionActorStorage(
        { ...scope, agentId: namespace.agentId, storePath: namespace.path, sessionActor: selected },
        {
          authority: namespace.authority,
          lifetime: {
            assertCurrent: () => namespace.authority.assertCurrent(),
            assertReadable: () => namespace.authority.assertCurrent(),
          },
        },
        consume,
      )) ?? missing
    );
  };
  const selection = {
    sessionId: scope.sessionId ?? scope.sessionEntry?.sessionId,
    sessionKey: scope.sessionKey,
  };
  return {
    memoryEntry(absPath: string, options: import("./session-files.js").BuildSessionEntryOptions) {
      return read(async (memory) => {
        const { buildSessionEntryFromSnapshot } = await import("./session-files.js");
        const snapshot = await memory.actor.storage.read(
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
          // A plugin callback is a disclosure effect; use the captured actor's live permission.
          () => {
            memory.actor.snapshot(memory.authority);
          },
        );
      }, null);
    },
    memoryResetRecall() {
      return read(
        (memory) =>
          memory.actor.storage.read(
            { type: "session.memory.resetRecall", input: selection },
            memory.authority,
          ),
        { state: "invalid" as const },
      );
    },
  };
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
export { isExecCompletionEvent } from "../../../../src/infra/heartbeat-events-filter.js";
export {
  parseSqliteSessionFileMarker,
  resolveStorePath,
} from "../../../../src/plugin-sdk/session-store-runtime.js";
export { hasInterSessionUserProvenance } from "../../../../src/sessions/input-provenance.js";
export { isCronRunSessionKey } from "../../../../src/sessions/session-key-utils.js";
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
