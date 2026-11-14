import type { ConversationRecord } from "../../../config/sessions/conversation-registry.types.js";
import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import type { ContextEngineRuntimeContext } from "../../../context-engine/types.js";
import type { CompactionRequestConstraints } from "../../sessions/compaction/request-budget.types.js";
import type { CompactionAppendPersistenceAsync } from "../../sessions/session-compaction-persistence.js";
import type { SessionManager } from "../../sessions/session-manager.js";
import { normalizeUsage, type UsageLike, type NormalizedUsage } from "../../usage.js";
import type { EmbeddedAgentCompactResult } from "../types.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";

/** Publish committed custody before model admission or handled hooks can bypass settlement. */
export function publishClaimedSessionWriter(
  observe: RunEmbeddedAgentInternalParams["onCompactionAccounting"],
  target: SessionTranscriptRuntimeTarget,
  entry: InternalSessionEntry,
): void {
  observe?.({
    kind: "durable",
    count: 0,
    target: {
      agentId: target.agentId,
      sessionId: entry.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      lifecycleRevision: entry.lifecycleRevision,
      activeWriterRunId: entry.activeWriterRunId,
    },
  });
}

export type CompactionAccountingReceipt = {
  tokensBefore: number;
  tokensAfter: number | undefined;
  compactionKind: "context-engine" | "server-endpoint";
  details?: unknown;
};

/** The manual lifecycle owner retains this view until its compaction settles. */
export type PreparedCompactionSession = {
  sessionTarget: SessionTranscriptRuntimeTarget;
  entry: InternalSessionEntry;
  sessionManager: SessionManager;
  metadataOnly?: boolean;
  primaryConversation?: ConversationRecord;
};

type CompactionAccountingRecorder = CompactionRequestConstraints & {
  /** The queued host owns plugin hooks and refresh; native internal events still run. */
  hostOwnsCompactionLifecycle?: boolean;
  /** A precheck can require budget recovery while its user request is still pending. */
  pendingRequestState?: "unresolved";
  preparedSession?: PreparedCompactionSession;
  withCompactionPersistenceAsync?: CompactionAppendPersistenceAsync;
  /** The caller's buffer owns recovery; its portable identity grants no durable access. */
  memoryTranscript?: {
    sessionManager: SessionManager;
    sessionTarget: SessionTranscriptRuntimeTarget;
    assertActive: () => void;
  };
  recordUsage?: (usage: NormalizedUsage) => void;
  recordCompaction?: (receipt: CompactionAccountingReceipt) => void;
  /** Provider facts for a failed compaction; the public engine result carries only its reason. */
  recordFailure?: (failure: NonNullable<EmbeddedAgentCompactResult["failure"]>) => void;
};

// Bind to the actual invocation context after watchdog projection. Public
// metadata cannot supply billing or committed-context facts for the owning run.
const recorderByRuntimeContext = new WeakMap<object, CompactionAccountingRecorder>();

export function attachCompactionAccountingRecorder(
  runtimeContext: ContextEngineRuntimeContext,
  recorder: CompactionAccountingRecorder,
): void {
  recorderByRuntimeContext.set(runtimeContext, recorder);
}

export function readCompactionAccountingRecorder(
  runtimeContext: object | undefined,
): CompactionAccountingRecorder | undefined {
  return runtimeContext ? recorderByRuntimeContext.get(runtimeContext) : undefined;
}

/** Normalize provider usage at the accounting bridge before publishing its receipt. */
export function compactionUsageSink(recorder: CompactionAccountingRecorder | undefined) {
  const recordUsage = recorder?.recordUsage;
  return recordUsage
    ? (usage: UsageLike) => {
        const normalized = normalizeUsage(usage);
        if (normalized) {
          recordUsage(normalized);
        }
      }
    : undefined;
}
