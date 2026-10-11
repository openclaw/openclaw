import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { ClosedTranscriptTurnReadResult } from "../../config/sessions/session-accessor.transcript-range.js";
import type {
  TranscriptTurnAdmission,
  TranscriptTurnBoundary,
} from "../../config/sessions/transcript-entry-anchor.js";
import type { ContextEngine } from "../../context-engine/types.js";

export type PendingContextEngineTurn = Readonly<{
  advancement_key: string;
  payload_json: string;
  session_id: string;
}>;

/** Persist only resolved model facts, never live capabilities or credential-bearing config. */
export type ContextEngineTurnRuntimeContext = Readonly<{
  provider?: string;
  modelId?: string;
  modelContextWindow?: number;
  tokenBudget?: number;
}>;

type AdmittedContextEngineTurnOutboxPayload = Readonly<{
  admission: TranscriptTurnAdmission;
  isHeartbeat: boolean;
  state: "admitted";
}>;

export type AcceptedContextEngineTurnOutboxPayload = Readonly<{
  boundary: TranscriptTurnBoundary;
  isHeartbeat: boolean;
  state: "accepted";
  runtimeContext?: ContextEngineTurnRuntimeContext;
}>;

export type ReadyContextEngineTurnOutboxPayload = Readonly<{
  boundary: TranscriptTurnBoundary;
  isHeartbeat: boolean;
  messages: AgentMessage[];
  state: "ready";
  runtimeContext?: ContextEngineTurnRuntimeContext;
}>;

export type ContextEngineTurnReadFailureKind = Exclude<
  ClosedTranscriptTurnReadResult,
  { kind: "ok" }
>["kind"];

export type BlockedContextEngineTurnOutboxPayload = Readonly<{
  boundary: TranscriptTurnBoundary;
  failure: Exclude<ContextEngineTurnReadFailureKind, "projection-unavailable">;
  isHeartbeat: boolean;
  state: "blocked";
}>;

export type ContextEngineTurnOutboxPayload =
  | AdmittedContextEngineTurnOutboxPayload
  | AcceptedContextEngineTurnOutboxPayload
  | BlockedContextEngineTurnOutboxPayload
  | ReadyContextEngineTurnOutboxPayload;

export function isRetryableContextEngineTurnReadFailure(
  kind: ContextEngineTurnReadFailureKind,
): kind is "projection-unavailable" {
  return kind === "projection-unavailable";
}

export type ContextEngineTurnOutboxFilter = Readonly<{
  engineId: string;
  ownerPluginId?: string;
}>;

/** Durable outbox rows the drain reads and settles through the agent database worker. */
export type ContextEngineTurnOutboxStore = Readonly<{
  /** Keep the selected owner through consumption and acknowledgment, outside its writer FIFO. */
  retain?<T>(operation: () => Promise<T>): Promise<T>;
  assertReadable?(): void;
  listPendingSessions(
    filter: ContextEngineTurnOutboxFilter & { sessionId?: string; limit: number },
  ): Promise<string[]>;
  readNextPending(
    filter: ContextEngineTurnOutboxFilter & { sessionId: string },
  ): Promise<PendingContextEngineTurn | undefined>;
  complete(advancementKey: string): Promise<void>;
  recordFailure(advancementKey: string, message: string, attemptedAt: number): Promise<void>;
  hasPending(filter: ContextEngineTurnOutboxFilter & { sessionId?: string }): Promise<boolean>;
}>;

export async function drainContextEngineTurnOutbox(params: {
  store: ContextEngineTurnOutboxStore;
  engine: ContextEngine;
  engineId: string;
  ownerPluginId?: string;
  sessionId?: string;
  limit?: number;
  /** Observe acknowledged turns without changing durable advancement on observer failure. */
  onCommitted?: (turn: Parameters<NonNullable<ContextEngine["commitTurn"]>>[0]) => void;
  warn: (message: string) => void;
}): Promise<{ pending: boolean }> {
  return params.store.retain
    ? params.store.retain(() => drainRetainedContextEngineTurnOutbox(params))
    : drainRetainedContextEngineTurnOutbox(params);
}

async function drainRetainedContextEngineTurnOutbox(
  params: Parameters<typeof drainContextEngineTurnOutbox>[0],
): Promise<{ pending: boolean }> {
  const { store } = params;
  const filter = { engineId: params.engineId, ownerPluginId: params.ownerPluginId };
  if (typeof params.engine.commitTurn !== "function") {
    return { pending: false };
  }
  let remaining = Math.max(0, params.limit ?? 16);
  if (remaining === 0) {
    return { pending: await store.hasPending({ ...filter, sessionId: params.sessionId }) };
  }
  let activeSessionIds = await store.listPendingSessions({
    ...filter,
    sessionId: params.sessionId,
    limit: remaining,
  });
  while (remaining > 0 && activeSessionIds.length > 0) {
    const continuingSessionIds: string[] = [];
    for (const sessionId of activeSessionIds) {
      if (remaining === 0) {
        break;
      }
      const row = await store.readNextPending({ ...filter, sessionId });
      if (!row) {
        continue;
      }
      remaining -= 1;
      if (await commitPendingContextEngineTurn({ ...params, store, row })) {
        continuingSessionIds.push(sessionId);
      }
    }
    activeSessionIds = continuingSessionIds;
  }
  return { pending: await store.hasPending({ ...filter, sessionId: params.sessionId }) };
}

async function commitPendingContextEngineTurn(params: {
  engine: ContextEngine;
  onCommitted?: (turn: Parameters<NonNullable<ContextEngine["commitTurn"]>>[0]) => void;
  row: PendingContextEngineTurn;
  store: ContextEngineTurnOutboxStore;
  warn: (message: string) => void;
}): Promise<boolean> {
  const { row } = params;
  try {
    const payload = JSON.parse(row.payload_json) as ContextEngineTurnOutboxPayload;
    if (payload.state !== "ready") {
      return false;
    }
    const commonParams = {
      advancementKey: row.advancement_key,
      admission: payload.boundary.admission,
      terminal: payload.boundary.terminal,
      messages: payload.messages,
      sessionId: payload.boundary.admission.sessionId,
      sessionKey: payload.boundary.admission.sessionKey,
      sessionTarget: {
        agentId: payload.boundary.admission.agentId,
        sessionId: payload.boundary.admission.sessionId,
        sessionKey: payload.boundary.admission.sessionKey,
        storePath: payload.boundary.admission.storePath,
      },
      isHeartbeat: payload.isHeartbeat,
      ...(payload.runtimeContext ? { runtimeContext: payload.runtimeContext } : {}),
    };
    params.store.assertReadable?.();
    const result = await params.engine.commitTurn?.(commonParams);
    if (!result) {
      throw new Error("context engine does not implement commitTurn");
    }
    if (result.status !== "committed" && result.status !== "duplicate") {
      throw new Error(`invalid commitTurn result status: ${String(result.status)}`);
    }
    await params.store.complete(row.advancement_key);
    // Notification is best effort after acknowledgment; its failure must never requeue a commit.
    try {
      params.store.assertReadable?.();
      params.onCommitted?.(commonParams);
    } catch (error) {
      params.warn(
        `[context-engine] committed turn notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.store.recordFailure(row.advancement_key, message, Date.now());
    params.warn(
      `[context-engine] durable turn advancement remains queued: ${row.advancement_key}: ${message}`,
    );
    return false;
  }
}

export type ContextEngineTurnOutboxWorkerOperations = {
  prepareRun: {
    input: ContextEngineTurnOutboxFilter & {
      admission?: TranscriptTurnAdmission;
      isHeartbeat: boolean;
      sessionId: string;
    };
    output: { warnings: string[]; pending: boolean; admitted: boolean };
  };
  listPendingSessions: {
    input: ContextEngineTurnOutboxFilter & { sessionId?: string; limit: number };
    output: string[];
  };
  readNextPending: {
    input: ContextEngineTurnOutboxFilter & { sessionId: string };
    output: PendingContextEngineTurn | undefined;
  };
  complete: { input: { advancementKey: string }; output: undefined };
  recordFailure: {
    input: { advancementKey: string; message: string; attemptedAt: number };
    output: undefined;
  };
  hasPending: { input: ContextEngineTurnOutboxFilter & { sessionId?: string }; output: boolean };
  enqueueIntent: {
    input: ContextEngineTurnOutboxFilter & {
      admission: TranscriptTurnAdmission;
      isHeartbeat: boolean;
    };
    output: undefined;
  };
  acceptIntent: {
    input: ContextEngineTurnOutboxFilter & {
      boundary: TranscriptTurnBoundary;
      isHeartbeat: boolean;
      runtimeContext?: ContextEngineTurnRuntimeContext;
    };
    output: undefined;
  };
  publishClosedTurn: {
    input: ContextEngineTurnOutboxFilter & {
      boundary: TranscriptTurnBoundary;
      isHeartbeat: boolean;
      maxBytes: number;
      maxEvents: number;
      runtimeContext?: ContextEngineTurnRuntimeContext;
    };
    output: ClosedTranscriptTurnReadResult["kind"];
  };
  discardIntent: {
    input: ContextEngineTurnOutboxFilter & { admission: TranscriptTurnAdmission };
    output: boolean;
  };
};
