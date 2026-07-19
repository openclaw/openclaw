/**
 * Gateway-backed agent run wait helpers.
 * Normalizes run wait responses, reads the latest assistant reply, and drains
 * pending run sets for tools that need synchronous completion semantics.
 */
import {
  addTimerTimeoutGraceMs,
  asDateTimestampMs,
  asPositiveSafeInteger,
  clampTimerTimeoutMs,
  parseFiniteNumber,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { hasRetryableConnectionErrorCode } from "../infra/retryable-network-errors.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-idempotency.js";
import { normalizeBlockedLivenessWaitStatus } from "../shared/agent-liveness.js";
import {
  isOpenClawInternalSourceReplyMirrorAssistantMessage,
  isOpenClawMessageToolMirrorAssistantMessage,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../shared/transcript-only-openclaw-assistant.js";
import {
  buildAgentRunTerminalOutcomeFromWaitResult,
  type AgentRunTerminalOutcome,
} from "./agent-run-terminal-outcome.js";
import {
  normalizeAgentRunTimeoutPhase,
  normalizeProviderStarted,
  type AgentRunTimeoutPhase,
} from "./run-timeout-attribution.js";
import { extractAssistantText, stripToolMessages } from "./tools/chat-history-text.js";

type GatewayCaller = typeof callGateway;

const DEFAULT_ASSISTANT_REPLY_HISTORY_LIMIT = 50;
// Match the gateway's maximum chat.history message request while bounding the
// number of round trips needed to find an older persisted run boundary.
const MAX_ATTRIBUTED_REPLY_HISTORY_MESSAGES = 1_000;
const MAX_ATTRIBUTED_REPLY_HISTORY_PAGES =
  MAX_ATTRIBUTED_REPLY_HISTORY_MESSAGES / DEFAULT_ASSISTANT_REPLY_HISTORY_LIMIT;

function resolveRunWaitTimeoutMs(value: number | undefined): number {
  return clampTimerTimeoutMs(parseFiniteNumber(value) ?? 1) ?? 1;
}

function resolveRunWaitDeadlineAtMs(params: { deadlineAtMs?: number; timeoutMs?: number }): number {
  if (params.deadlineAtMs !== undefined) {
    return asDateTimestampMs(params.deadlineAtMs) ?? resolveDateTimestampMs(Date.now());
  }
  return (
    resolveExpiresAtMsFromDurationMs(resolveRunWaitTimeoutMs(params.timeoutMs)) ??
    resolveDateTimestampMs(Date.now())
  );
}

/** Latest assistant reply plus a stable fingerprint for baseline comparisons. */
export type AssistantReplySnapshot = {
  text?: string;
  fingerprint?: string;
};

/** Normalized terminal or pending state returned by `agent.wait`. */
export type AgentWaitResult = {
  status: "ok" | "timeout" | "error" | "pending";
  error?: string;
  startedAt?: number;
  endedAt?: number;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  pendingError?: boolean;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
};

/** Summary returned after waiting for a dynamic set of pending runs to drain. */
type AgentRunsDrainResult = {
  timedOut: boolean;
  pendingRunIds: string[];
  deadlineAtMs: number;
};

type RawAgentWaitResponse = {
  status?: string;
  error?: string;
  startedAt?: unknown;
  endedAt?: unknown;
  stopReason?: unknown;
  livenessState?: unknown;
  yielded?: unknown;
  pendingError?: unknown;
  timeoutPhase?: unknown;
  providerStarted?: unknown;
};

type RawChatHistoryResponse = {
  messages?: unknown;
  offset?: unknown;
  nextOffset?: unknown;
  hasMore?: unknown;
  totalMessages?: unknown;
};

function normalizeAgentWaitResult(
  status: AgentWaitResult["status"],
  wait?: RawAgentWaitResponse,
): AgentWaitResult {
  const stopReason = typeof wait?.stopReason === "string" ? wait.stopReason : undefined;
  const terminalOutcome = buildAgentRunTerminalOutcomeFromWaitResult({ ...wait, status });
  const normalized = normalizeTerminalOutcomeForWait(terminalOutcome, status, wait?.livenessState);
  return {
    status: normalized.status,
    error: normalized.error,
    startedAt: typeof wait?.startedAt === "number" ? wait.startedAt : undefined,
    endedAt: typeof wait?.endedAt === "number" ? wait.endedAt : undefined,
    stopReason,
    livenessState: typeof wait?.livenessState === "string" ? wait.livenessState : undefined,
    yielded: wait?.yielded === true ? true : undefined,
    pendingError: wait?.pendingError === true ? true : undefined,
    timeoutPhase: normalizeAgentRunTimeoutPhase(wait?.timeoutPhase),
    providerStarted: normalizeProviderStarted(wait?.providerStarted),
  };
}

function normalizeTerminalOutcomeForWait(
  outcome: AgentRunTerminalOutcome | undefined,
  fallbackStatus: AgentWaitResult["status"],
  livenessState?: unknown,
): { status: AgentWaitResult["status"]; error?: string } {
  if (outcome?.reason === "hard_timeout") {
    return { status: outcome.status, error: outcome.error };
  }
  return normalizeBlockedLivenessWaitStatus({
    status: outcome?.status ?? fallbackStatus,
    livenessState,
    error: outcome?.error,
  });
}

const RECOVERABLE_AGENT_WAIT_ERROR_PATTERNS: readonly RegExp[] = [
  /gateway closed \(1006/i,
  /transport close/i,
  /connection loss/i,
  /connection closed/i,
  /gateway not connected/i,
  /no active .* listener/i,
  /socket hang up/i,
];

/** Return true for transient gateway/transport failures that callers may retry. */
export function isRecoverableAgentWaitError(error: string | undefined): boolean {
  const message = error?.trim();
  if (!message) {
    return false;
  }
  if (message.includes("gateway timeout")) {
    return false;
  }
  return (
    hasRetryableConnectionErrorCode(message) ||
    RECOVERABLE_AGENT_WAIT_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  );
}

function normalizePendingRunIds(runIds: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const runId of runIds) {
    const normalized = runId.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
  }
  return [...seen];
}

function isWaitedReplyTranscriptArtifact(message: unknown): boolean {
  return (
    isTranscriptOnlyOpenClawAssistantMessage(message) ||
    isOpenClawMessageToolMirrorAssistantMessage(message) ||
    isInterSessionInputMessage(message)
  );
}

function isInterSessionInputMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const provenance = (message as { provenance?: unknown }).provenance;
  return (
    Boolean(provenance) &&
    typeof provenance === "object" &&
    !Array.isArray(provenance) &&
    (provenance as { kind?: unknown }).kind === "inter_session"
  );
}

function isWaitedReplyTurnBoundary(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  return (message as { role?: unknown }).role === "user" || isInterSessionInputMessage(message);
}

function isProjectedTurnBoundary(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const meta = (message as { __openclaw?: unknown })["__openclaw"];
  return (
    Boolean(meta) &&
    typeof meta === "object" &&
    !Array.isArray(meta) &&
    (meta as { turnBoundary?: unknown }).turnBoundary === true
  );
}

function snapshotAssistantReply(message: unknown): AssistantReplySnapshot | undefined {
  const text = extractAssistantText(message);
  if (!text?.trim()) {
    return undefined;
  }
  let fingerprint: string | undefined;
  try {
    fingerprint = JSON.stringify(message);
  } catch {
    fingerprint = text;
  }
  return { text, fingerprint };
}

function readTranscriptMessageSeq(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const meta = (message as { __openclaw?: unknown })["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  return asPositiveSafeInteger((meta as { seq?: unknown }).seq);
}

function readTranscriptMessageIdempotencyKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  const direct = record.idempotencyKey;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const meta = record["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const projected = (meta as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof projected === "string" && projected.trim() ? projected.trim() : undefined;
}

function resolveRunScopedTranscriptTurn(messages: unknown[], runId: string): unknown[] | undefined {
  const userTurnIdempotencyKey = buildRunUserTurnIdempotencyKey(runId);
  let startIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      isWaitedReplyTurnBoundary(message) &&
      readTranscriptMessageIdempotencyKey(message) === userTurnIdempotencyKey
    ) {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) {
    return undefined;
  }
  let endIndex = messages.length;
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    if (isWaitedReplyTurnBoundary(messages[index]) || isProjectedTurnBoundary(messages[index])) {
      endIndex = index;
      break;
    }
  }
  return messages.slice(startIndex, endIndex);
}

function containsRunScopedTranscriptBoundary(messages: unknown[], runId: string): boolean {
  const userTurnIdempotencyKey = buildRunUserTurnIdempotencyKey(runId);
  return messages.some(
    (message) =>
      isWaitedReplyTurnBoundary(message) &&
      readTranscriptMessageIdempotencyKey(message) === userTurnIdempotencyKey,
  );
}

function readNonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function readAssistantReplyHistory(params: {
  sessionKey: string;
  agentId?: string;
  limit: number;
  attributableToRunId?: string;
  deadlineAtMs?: number;
  callGateway: GatewayCaller;
}): Promise<unknown[] | undefined> {
  const historyPages: unknown[][] = [];
  let offset: number | undefined;
  let totalMessagesCeiling: number | undefined;
  let pageCount = 0;
  let messageCount = 0;

  for (;;) {
    if (
      params.attributableToRunId &&
      (pageCount >= MAX_ATTRIBUTED_REPLY_HISTORY_PAGES ||
        messageCount >= MAX_ATTRIBUTED_REPLY_HISTORY_MESSAGES)
    ) {
      return undefined;
    }
    const remainingMs =
      params.deadlineAtMs === undefined ? undefined : params.deadlineAtMs - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return undefined;
    }
    const history = await params.callGateway<RawChatHistoryResponse>({
      method: "chat.history",
      params: {
        sessionKey: params.sessionKey,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        limit: params.limit,
        ...(offset !== undefined ? { offset } : {}),
      },
      ...(remainingMs !== undefined ? { timeoutMs: resolveRunWaitTimeoutMs(remainingMs) } : {}),
    });
    if (params.deadlineAtMs !== undefined && Date.now() >= params.deadlineAtMs) {
      return undefined;
    }
    if (offset !== undefined) {
      const responseOffset = readNonNegativeSafeInteger(history.offset);
      const responseTotalMessages = readNonNegativeSafeInteger(history.totalMessages);
      if (responseOffset !== offset || responseTotalMessages !== totalMessagesCeiling) {
        return undefined;
      }
    }
    const pageMessages = Array.isArray(history?.messages) ? history.messages : [];
    pageCount += 1;
    if (
      params.attributableToRunId &&
      messageCount + pageMessages.length > MAX_ATTRIBUTED_REPLY_HISTORY_MESSAGES
    ) {
      return undefined;
    }
    messageCount += pageMessages.length;
    // Offset pages walk newest-to-oldest while each page remains chronological.
    // Retain every page so newer rows still delimit the attributed run once its boundary appears.
    historyPages.push(pageMessages);

    if (
      params.attributableToRunId &&
      containsRunScopedTranscriptBoundary(pageMessages, params.attributableToRunId)
    ) {
      break;
    }
    if (!params.attributableToRunId) {
      break;
    }
    if (history?.hasMore !== true) {
      return undefined;
    }

    const currentOffset = offset ?? 0;
    const responseOffset = readNonNegativeSafeInteger(history.offset);
    if (history.offset !== undefined && responseOffset !== currentOffset) {
      return undefined;
    }
    const nextOffset = readNonNegativeSafeInteger(history.nextOffset);
    const totalMessages = readNonNegativeSafeInteger(history.totalMessages);
    if (
      nextOffset === undefined ||
      nextOffset <= currentOffset ||
      totalMessages === undefined ||
      nextOffset > totalMessages ||
      (totalMessagesCeiling !== undefined && totalMessages !== totalMessagesCeiling)
    ) {
      return undefined;
    }
    totalMessagesCeiling = totalMessages;
    offset = nextOffset;
  }

  return historyPages.toReversed().flat();
}

function readInternalSourceReplyMessageSeq(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const marker = (message as { openclawMessageToolMirror?: unknown }).openclawMessageToolMirror;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return undefined;
  }
  return asPositiveSafeInteger((marker as { sourceMessageSeq?: unknown }).sourceMessageSeq);
}

function resolveLatestAssistantReplySnapshot(
  messages: unknown[],
  opts?: { stopAtTranscriptArtifact?: boolean; attributableToRunId?: string },
): AssistantReplySnapshot {
  const scopedMessages = opts?.attributableToRunId
    ? resolveRunScopedTranscriptTurn(messages, opts.attributableToRunId)
    : messages;
  // The run's persisted `<runId>:user` boundary is the attribution source.
  // Missing or truncated metadata must fail closed instead of borrowing another turn's reply.
  if (!scopedMessages) {
    return {};
  }
  let latestReply: AssistantReplySnapshot = {};
  const internalSourceReplies: Array<{
    snapshot: AssistantReplySnapshot;
    sourceMessageSeq?: number;
  }> = [];
  let sawTranscriptArtifact = false;
  for (let i = scopedMessages.length - 1; i >= 0; i -= 1) {
    const candidate = scopedMessages[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if (opts?.stopAtTranscriptArtifact === true && isWaitedReplyTurnBoundary(candidate)) {
      const boundarySeq = readTranscriptMessageSeq(candidate);
      const currentInternalSourceReply = boundarySeq
        ? internalSourceReplies.find(
            (reply) => reply.sourceMessageSeq !== undefined && reply.sourceMessageSeq > boundarySeq,
          )
        : undefined;
      if (currentInternalSourceReply) {
        return currentInternalSourceReply.snapshot;
      }
      if (!boundarySeq && internalSourceReplies.length > 0) {
        sawTranscriptArtifact = true;
      }
      internalSourceReplies.length = 0;
      break;
    }
    if ((candidate as { role?: unknown }).role !== "assistant") {
      continue;
    }
    if (
      opts?.stopAtTranscriptArtifact === true &&
      isOpenClawInternalSourceReplyMirrorAssistantMessage(candidate)
    ) {
      // Internal source replies still need the outer A2A flow to deliver them.
      // The source seq prevents a late old result from crossing a new turn.
      const snapshot = snapshotAssistantReply(candidate);
      const sourceMessageSeq = readInternalSourceReplyMessageSeq(candidate);
      if (snapshot) {
        internalSourceReplies.push({ snapshot, sourceMessageSeq });
      }
      if (!sourceMessageSeq) {
        sawTranscriptArtifact = true;
      }
      continue;
    }
    if (isWaitedReplyTranscriptArtifact(candidate)) {
      if (opts?.stopAtTranscriptArtifact === true) {
        sawTranscriptArtifact = true;
      }
      continue;
    }
    const snapshot = snapshotAssistantReply(candidate);
    if (!snapshot) {
      continue;
    }
    if (opts?.stopAtTranscriptArtifact !== true) {
      return snapshot;
    }
    if (!latestReply.text) {
      latestReply = snapshot;
    }
  }
  if (opts?.stopAtTranscriptArtifact === true) {
    if (internalSourceReplies.length > 0) {
      sawTranscriptArtifact = true;
    }
    if (sawTranscriptArtifact) {
      return {};
    }
  }
  return latestReply;
}

export function hasUpdatedAssistantReplySnapshot(
  latestReply: AssistantReplySnapshot,
  baseline: AssistantReplySnapshot | undefined,
): boolean {
  if (!latestReply.text) {
    return false;
  }
  if (!baseline) {
    return true;
  }
  if (baseline.fingerprint !== undefined) {
    return latestReply.fingerprint !== baseline.fingerprint;
  }
  if (baseline.text !== undefined) {
    return latestReply.text !== baseline.text;
  }
  return true;
}

/** Read the latest non-tool assistant message for a session. */
export async function readLatestAssistantReplySnapshot(params: {
  sessionKey: string;
  agentId?: string;
  limit?: number;
  // Waited reply paths stop at transcript artifacts so they do not resurrect
  // an older assistant message as a fresh post-run reply.
  stopAtTranscriptArtifact?: boolean;
  // Restrict reply extraction to the transcript turn persisted for this run.
  attributableToRunId?: string;
  // Waited reply reads share the agent.wait deadline instead of starting a new timeout window.
  deadlineAtMs?: number;
  callGateway?: GatewayCaller;
}): Promise<AssistantReplySnapshot> {
  let messages: unknown[] | undefined;
  try {
    messages = await readAssistantReplyHistory({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      limit: params.limit ?? DEFAULT_ASSISTANT_REPLY_HISTORY_LIMIT,
      attributableToRunId: params.attributableToRunId,
      deadlineAtMs: params.deadlineAtMs,
      callGateway: params.callGateway ?? callGateway,
    });
  } catch (error) {
    if (!params.attributableToRunId) {
      throw error;
    }
    return {};
  }
  if (!messages) {
    return {};
  }
  return resolveLatestAssistantReplySnapshot(stripToolMessages(messages), {
    stopAtTranscriptArtifact: params.stopAtTranscriptArtifact,
    attributableToRunId: params.attributableToRunId,
  });
}

/** Read only the latest assistant text for call sites that do not need fingerprints. */
export async function readLatestAssistantReply(params: {
  sessionKey: string;
  agentId?: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<string | undefined> {
  return (
    await readLatestAssistantReplySnapshot({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      limit: params.limit,
      callGateway: params.callGateway,
    })
  ).text;
}

/** Wait for one agent run through the gateway and normalize timeout/error states. */
export async function waitForAgentRun(params: {
  runId: string;
  timeoutMs: number;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult> {
  const timeoutMs = resolveRunWaitTimeoutMs(params.timeoutMs);
  try {
    const wait = await (params.callGateway ?? callGateway)({
      method: "agent.wait",
      params: {
        runId: params.runId,
        timeoutMs,
      },
      timeoutMs: addTimerTimeoutGraceMs(timeoutMs, 2_000),
    });
    if (wait?.status === "timeout") {
      return normalizeAgentWaitResult("timeout", wait);
    }
    if (wait?.status === "pending") {
      return normalizeAgentWaitResult("pending", wait);
    }
    if (wait?.status === "error") {
      return normalizeAgentWaitResult("error", wait);
    }
    return normalizeAgentWaitResult("ok", wait);
  } catch (err) {
    const error = formatErrorMessage(err);
    return {
      status: error.includes("gateway timeout") ? "timeout" : "error",
      error,
    };
  }
}

/** Wait for a run and return a reply only when it differs from the supplied baseline. */
export async function waitForAgentRunAndReadUpdatedAssistantReply(params: {
  runId: string;
  sessionKey: string;
  agentId?: string;
  timeoutMs: number;
  limit?: number;
  baseline?: AssistantReplySnapshot;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult & { replyText?: string }> {
  const deadlineAtMs = resolveRunWaitDeadlineAtMs({ timeoutMs: params.timeoutMs });
  const wait = await waitForAgentRun({
    runId: params.runId,
    timeoutMs: params.timeoutMs,
    callGateway: params.callGateway,
  });
  if (wait.status !== "ok") {
    return wait;
  }
  if (Date.now() >= deadlineAtMs) {
    return { ...wait, replyText: undefined };
  }

  const latestReply = await readLatestAssistantReplySnapshot({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    limit: params.limit,
    stopAtTranscriptArtifact: true,
    attributableToRunId: params.runId,
    deadlineAtMs,
    callGateway: params.callGateway,
  });
  const replyText = hasUpdatedAssistantReplySnapshot(latestReply, params.baseline)
    ? latestReply.text
    : undefined;
  return {
    ...wait,
    replyText,
  };
}

/** Wait until the current and newly spawned pending run IDs are drained or timed out. */
export async function waitForAgentRunsToDrain(params: {
  getPendingRunIds: () => Iterable<string>;
  initialPendingRunIds?: Iterable<string>;
  timeoutMs?: number;
  deadlineAtMs?: number;
  callGateway?: GatewayCaller;
}): Promise<AgentRunsDrainResult> {
  const deadlineAtMs = resolveRunWaitDeadlineAtMs(params);

  // Runs may finish and spawn more runs, so refresh until no pending IDs remain.
  let pendingRunIds = new Set<string>(
    normalizePendingRunIds(params.initialPendingRunIds ?? params.getPendingRunIds()),
  );

  while (pendingRunIds.size > 0 && Date.now() < deadlineAtMs) {
    const remainingMs = Math.max(1, deadlineAtMs - Date.now());
    await Promise.allSettled(
      [...pendingRunIds].map((runId) =>
        waitForAgentRun({
          runId,
          timeoutMs: remainingMs,
          callGateway: params.callGateway,
        }),
      ),
    );
    pendingRunIds = new Set<string>(normalizePendingRunIds(params.getPendingRunIds()));
  }

  return {
    timedOut: pendingRunIds.size > 0,
    pendingRunIds: [...pendingRunIds],
    deadlineAtMs,
  };
}
