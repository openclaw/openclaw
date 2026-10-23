import { formatCompactTokenCount, safeParseJsonRecord } from "@openclaw/normalization-core";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  asOptionalObjectRecord,
  asOptionalRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import {
  findTranscriptEvent,
  type SessionTranscriptRuntimeTarget,
} from "../../../config/sessions/session-accessor.js";
import { findSessionTranscriptArchiveEventReadOnly } from "../../../config/sessions/session-history.js";
import { resolveFreshSessionTotalTokens } from "../../../config/sessions/types.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
import { isSilentAssistantTranscriptMessage } from "../../../shared/chat-message-content.js";
import { isContractToolCallBlock, readToolCallName } from "../../../shared/tool-block-contract.js";
import { sleep } from "../../../utils/sleep.js";
import { extractStoredAssistantText } from "../../tools/chat-history-text.js";
import { resolveSubagentChildAgentId } from "../registry/subagent-child-owner-match.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunReadRecord } from "../registry/subagent-registry-read.types.js";
import { prepareSubagentRunsSnapshotForRunIds } from "../registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { isRequesterCompletionCohortCurrent } from "../registry/subagent-requester-settle-identity.js";
import { recordLatestSubagentRun } from "../registry/subagent-run-generation.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import {
  buildChildCompletionFindings,
  readSubagentRunAnnounceResultUsing,
  readSubagentRunFinalAnswerUsing,
  SubagentAnnouncePreparationConflictError,
  type ChildCompletionRow,
  type PreparedAnnounceResult,
} from "./subagent-announce-result.js";
import {
  callSubagentLifecycleGateway,
  getRuntimeConfig,
  readSubagentSessionEntry,
  readSessionMessagesAsync,
  resolveSessionStorePathCore,
} from "./subagent-announce.runtime.js";

function readStructuredToolPayload(content: unknown): Record<string, unknown> | undefined {
  const record = asOptionalRecord(content);
  if (record) {
    return record;
  }
  if (typeof content === "string") {
    return safeParseJsonRecord(content.trim());
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    const text = asOptionalRecord(block)?.text;
    if (typeof text !== "string") {
      continue;
    }
    const parsed = safeParseJsonRecord(text.trim());
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

const FAST_TEST_RETRY_INTERVAL_MS = 8;

type SubagentOutputSnapshot = {
  latestText?: string;
  latestToolCallCount?: number;
  waitingForContinuation?: boolean;
};

export function withSubagentOutcomeTiming(
  outcome: SubagentRunOutcome,
  timing: {
    startedAt?: number;
    endedAt?: number;
  },
): SubagentRunOutcome {
  const startedAt = asFiniteNumber(timing.startedAt) ?? asFiniteNumber(outcome.startedAt);
  const endedAt = asFiniteNumber(timing.endedAt) ?? asFiniteNumber(outcome.endedAt);
  const nextTiming: Pick<SubagentRunOutcome, "startedAt" | "endedAt" | "elapsedMs"> = {};
  if (typeof startedAt === "number") {
    nextTiming.startedAt = startedAt;
  }
  if (typeof endedAt === "number") {
    nextTiming.endedAt = endedAt;
  }
  if (typeof startedAt === "number" && typeof endedAt === "number") {
    nextTiming.elapsedMs = Math.max(0, endedAt - startedAt);
  }
  return { ...outcome, ...nextTiming };
}

function summarizeSubagentOutputHistory(
  messages: Array<unknown>,
  completedCollectorTurn = false,
): SubagentOutputSnapshot {
  const snapshot: SubagentOutputSnapshot = {};
  let previousAssistantCalledYield = false;
  for (const message of messages) {
    const record = asOptionalObjectRecord(message);
    if (!record) {
      continue;
    }
    const { role, provenance } = record;
    if (role === "user" || (isRecord(provenance) && provenance.kind === "inter_session")) {
      // A fresh input owns a new turn; never announce an older turn's reply
      // when the current run fails or completes without visible output.
      snapshot.latestText = undefined;
      snapshot.latestToolCallCount = undefined;
      snapshot.waitingForContinuation = false;
      previousAssistantCalledYield = false;
      continue;
    }
    if (role === "assistant") {
      previousAssistantCalledYield =
        !Array.isArray(record) &&
        ((Array.isArray(record.content) &&
          record.content.some(
            (block) =>
              isContractToolCallBlock(block) && readToolCallName(block) === "sessions_yield",
          )) ||
          [record.toolCalls, record.tool_calls].some(
            (toolCalls) =>
              Array.isArray(toolCalls) &&
              toolCalls.some((toolCall) => {
                const callRecord = asOptionalRecord(toolCall);
                return callRecord ? readToolCallName(callRecord) === "sessions_yield" : false;
              }),
          ));
      snapshot.waitingForContinuation = previousAssistantCalledYield;
      if (completedCollectorTurn && previousAssistantCalledYield) {
        // The yielded result replaces earlier progress, even for a timed-out collector.
        snapshot.latestToolCallCount = undefined;
      }
      if (isSilentAssistantTranscriptMessage(message)) {
        snapshot.latestText = undefined;
        continue;
      }
      if (previousAssistantCalledYield) {
        // A completed collector cannot resume: its yield closes this execution.
        // Ordinary subagents still wait rather than treating commentary as a result.
        // An empty yield is not permission to reuse an earlier assistant reply.
        snapshot.latestText = completedCollectorTurn
          ? extractStoredAssistantText(message)?.trim() || undefined
          : undefined;
        continue;
      }
      const toolCalls = record.toolCalls ?? record.tool_calls;
      const toolCallCount =
        (Array.isArray(record.content)
          ? record.content.filter(isContractToolCallBlock).length
          : 0) + (Array.isArray(toolCalls) ? toolCalls.length : 0);
      if (toolCallCount > 0) {
        // Any assistant tool call proves this was an intermediate turn. Do not
        // retain commentary from this message or an earlier assistant message
        // as the run's final result if execution ends before the next reply.
        snapshot.latestText = undefined;
        snapshot.latestToolCallCount = (snapshot.latestToolCallCount ?? 0) + toolCallCount;
        continue;
      }
      const text = extractStoredAssistantText(message)?.trim();
      if (text) {
        snapshot.latestText = text;
      }
      continue;
    }
    // Some providers omit the tool name on results; use adjacency plus yielded status as fallback.
    if (
      !Array.isArray(record) &&
      (role === "toolResult" || role === "tool") &&
      (readToolCallName(record) === "sessions_yield" ||
        (previousAssistantCalledYield &&
          (asOptionalRecord(record.details)?.status === "yielded" ||
            readStructuredToolPayload(record.content)?.status === "yielded")))
    ) {
      if (!completedCollectorTurn) {
        snapshot.latestText = undefined;
      }
      snapshot.waitingForContinuation = true;
      previousAssistantCalledYield = false;
      continue;
    }
    previousAssistantCalledYield = false;
  }
  return snapshot;
}

export async function readSubagentOutput(
  sessionKey: string,
  outcome?: SubagentRunOutcome,
  options?: {
    childAgentId?: string;
    sessionTarget?: SessionTranscriptRuntimeTarget;
    completedCollectorTurn?: { startedAt: number; endedAt: number };
  },
): Promise<string | undefined> {
  const agentId =
    options?.sessionTarget?.agentId ??
    resolveSubagentChildAgentId({
      childSessionKey: sessionKey,
      childAgentId: options?.childAgentId,
    });
  if (!agentId) {
    return undefined;
  }
  const collectorTurn = options?.completedCollectorTurn;
  if (
    collectorTurn &&
    (!options?.sessionTarget ||
      !Number.isFinite(collectorTurn.startedAt) ||
      !Number.isFinite(collectorTurn.endedAt) ||
      collectorTurn.endedAt < collectorTurn.startedAt)
  ) {
    return undefined;
  }
  let messages: unknown[] | undefined;
  if (options?.sessionTarget) {
    messages = await readSessionMessagesAsync(
      options.sessionTarget,
      collectorTurn
        ? { mode: "full", reason: "completed collector execution result" }
        : { mode: "recent", maxMessages: 100, maxBytes: 1024 * 1024 },
    );
  }
  const history =
    messages === undefined
      ? await callSubagentLifecycleGateway({
          method: "chat.history",
          params: { sessionKey, limit: 100, agentId },
        })
      : undefined;
  const sourceMessages = messages ?? (Array.isArray(history?.messages) ? history.messages : []);
  // A restart may read this session long after newer turns evicted the yielded reply
  // from recent history. Read its original execution, never those later turns.
  const executionMessages = collectorTurn
    ? sourceMessages.filter((message) => {
        const record = asOptionalObjectRecord(message);
        const metadata = asOptionalObjectRecord(record?.["__openclaw"]);
        const timestamp =
          asFiniteNumber(metadata?.recordTimestampMs) ?? asFiniteNumber(record?.timestamp);
        return (
          timestamp !== undefined &&
          timestamp >= collectorTurn.startedAt &&
          timestamp <= collectorTurn.endedAt
        );
      })
    : sourceMessages;
  const snapshot = summarizeSubagentOutputHistory(executionMessages, collectorTurn !== undefined);
  if (snapshot.waitingForContinuation && !collectorTurn) {
    return undefined;
  }
  if (snapshot.latestText) {
    return snapshot.latestText;
  }
  // Tool activity is partial-progress evidence only for a timed-out run. It is
  // not authoritative completion output when producer terminal facts are absent.
  if (outcome?.status === "timeout" && (snapshot.latestToolCallCount ?? 0) > 0) {
    return `${snapshot.latestToolCallCount} tool call(s) made without visible output.`;
  }
  return undefined;
}

async function readOutputWithRetry(
  maxWaitMs: number,
  retryIntervalMs: number,
  readOutput: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const waitMs = Math.max(0, Math.min(maxWaitMs, 15_000));
  if (!(waitMs > 0)) {
    return undefined;
  }
  const deadlineAt = performance.now() + waitMs;
  for (;;) {
    const result = await readOutput();
    if (result?.trim()) {
      return result;
    }
    const remainingMs = deadlineAt - performance.now();
    if (remainingMs <= 0) {
      return result;
    }
    await sleep(Math.min(retryIntervalMs, remainingMs));
  }
}

export async function readLatestSubagentOutputWithRetry(params: {
  sessionKey: string;
  childAgentId?: string;
  maxWaitMs: number;
  outcome?: SubagentRunOutcome;
}): Promise<string | undefined> {
  return await readOutputWithRetry(
    params.maxWaitMs,
    isFastTestRuntimeEnv() ? FAST_TEST_RETRY_INTERVAL_MS : 100,
    () =>
      readSubagentOutput(params.sessionKey, params.outcome, { childAgentId: params.childAgentId }),
  );
}

export async function readSubagentTimeoutProgress(
  sessionKey: string,
  maxWaitMs: number,
  outcome: SubagentRunOutcome,
  childAgentId?: string,
): Promise<string | undefined> {
  const initial = await readSubagentOutput(sessionKey, outcome, { childAgentId });
  const progress = initial?.trim()
    ? initial
    : await readLatestSubagentOutputWithRetry({ sessionKey, childAgentId, maxWaitMs, outcome });
  return progress;
}

export async function captureSubagentCompletionReply(
  sessionKey: string,
  options?: {
    waitForReply?: boolean;
    outcome?: SubagentRunOutcome;
    sessionTarget?: SessionTranscriptRuntimeTarget;
    completedCollectorTurn?: { startedAt: number; endedAt: number };
  },
): Promise<string | undefined> {
  const waitForReply = options?.waitForReply;
  const maxWaitMs = isFastTestRuntimeEnv() ? 50 : 1_500;
  const retryIntervalMs = isFastTestRuntimeEnv() ? FAST_TEST_RETRY_INTERVAL_MS : 100;
  const readOutput = () =>
    readSubagentOutput(sessionKey, options?.outcome, {
      sessionTarget: options?.sessionTarget,
      completedCollectorTurn: options?.completedCollectorTurn,
    });
  const immediate = await readOutput();
  if (immediate?.trim()) {
    return immediate;
  }
  if (waitForReply === false) {
    return undefined;
  }
  return await readOutputWithRetry(maxWaitMs, retryIntervalMs, readOutput);
}

type AnnounceRunReader = (runId: string) => SubagentRunRecord | undefined;

async function prepareAnnounceRunReader(runIds: string[]): Promise<AnnounceRunReader> {
  const prepared = await prepareSubagentRunsSnapshotForRunIds(subagentRuns, runIds);
  return (runId) => {
    const current = prepared.consume((runs) => runs.get(runId));
    return current.ready ? current.value : undefined;
  };
}

export async function readSubagentRunAnnounceResult(
  child: SubagentRunRecord,
  readSubagentRun?: AnnounceRunReader,
): Promise<PreparedAnnounceResult> {
  return await readSubagentRunAnnounceResultUsing(child, {
    readSubagentRun: readSubagentRun ?? (await prepareAnnounceRunReader([child.runId])),
    findTranscriptEvent,
    findSessionTranscriptArchiveEventReadOnly,
    getRuntimeConfig,
    readSubagentSessionEntry,
    resolveSessionStorePathCore,
  });
}

/** The complete final answer recorded by this run, or undefined when retention removed it. */
export async function readSubagentRunFinalAnswer(
  child: SubagentRunRecord,
): Promise<string | undefined> {
  return await readSubagentRunFinalAnswerUsing(child, {
    findTranscriptEvent,
    findSessionTranscriptArchiveEventReadOnly,
    getRuntimeConfig,
    readSubagentSessionEntry,
    resolveSessionStorePathCore,
  });
}

/** Prepare complete result text without changing the bounded lifecycle evidence. */
export async function readChildCompletionFindings(
  children: SubagentRunRecord[],
  readSubagentRun?: AnnounceRunReader,
): Promise<PreparedAnnounceResult> {
  const readCurrent =
    readSubagentRun ?? (await prepareAnnounceRunReader(children.map((child) => child.runId)));
  const results = await Promise.all(
    children.map(async (observed) => {
      const prepared = await readSubagentRunAnnounceResult(observed, readCurrent);
      const child = readCurrent(observed.runId);
      if (!child) {
        throw new SubagentAnnouncePreparationConflictError(
          "A child result changed while preparing the completion batch.",
        );
      }
      return { child, ...prepared };
    }),
  );
  const isCurrent = () => results.every((result) => result.isCurrent());
  if (!isCurrent()) {
    throw new SubagentAnnouncePreparationConflictError(
      "A child result changed while preparing the completion batch.",
    );
  }
  return {
    text: buildChildCompletionFindings(
      results.map(({ child, text }) => Object.assign({}, child, { announceResult: text })),
    ),
    isCurrent,
  };
}

export function dedupeLatestChildCompletionRows<
  T extends ChildCompletionRow & { runId: string; generation?: number },
>(children: T[]): T[] {
  const latestByChildOwner = new Map<string, (typeof children)[number]>();
  for (const child of children) {
    const key = JSON.stringify([resolveSubagentChildAgentId(child), child.childSessionKey]);
    recordLatestSubagentRun(latestByChildOwner, key, child);
  }
  return [...latestByChildOwner.values()];
}

export function filterCurrentDirectChildCompletionRows<
  T extends ChildCompletionRow & {
    runId: string;
    childAgentId?: string;
    requesterSessionKey: string;
    requesterAgentId?: string;
  },
>(
  children: T[],
  params: {
    requesterSessionKey: string;
    requesterAgentId?: string;
    getLatestSubagentRunByChildSessionKey: (
      childSessionKey: string,
      childAgentId?: string,
    ) => SubagentRunReadRecord | null;
  },
): T[] {
  return children.filter((child) => {
    const latest = params.getLatestSubagentRunByChildSessionKey(
      child.childSessionKey,
      child.childAgentId,
    );
    if (!latest) {
      return true;
    }
    return (
      latest.runId === child.runId &&
      latest.requesterSessionKey === params.requesterSessionKey &&
      (!params.requesterAgentId || latest.requesterAgentId === params.requesterAgentId)
    );
  });
}

export function selectCurrentRequesterCompletionRows(params: {
  rows: SubagentRunRecord[];
  requesterSessionKey: string;
  requesterAgentId?: string;
  frozenBatch: boolean;
  latestForSession: Parameters<typeof isRequesterCompletionCohortCurrent>[1];
}): SubagentRunRecord[] {
  if (params.frozenBatch) {
    return params.rows.filter((entry) =>
      isRequesterCompletionCohortCurrent(entry, params.latestForSession),
    );
  }
  return dedupeLatestChildCompletionRows(
    filterCurrentDirectChildCompletionRows(params.rows, {
      requesterSessionKey: params.requesterSessionKey,
      requesterAgentId: params.requesterAgentId,
      getLatestSubagentRunByChildSessionKey: (childSessionKey, childAgentId) =>
        params.latestForSession(childSessionKey, undefined, childAgentId),
    }),
  );
}

function formatTokenCount(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "0";
  }
  return formatCompactTokenCount(value);
}

export async function buildCompactAnnounceStatsLine(params: {
  sessionKey: string;
  childAgentId?: string;
  startedAt?: number;
  endedAt?: number;
}) {
  const cfg = getRuntimeConfig();
  const agentId = resolveSubagentChildAgentId({
    childSessionKey: params.sessionKey,
    childAgentId: params.childAgentId,
  });
  const storePath = agentId
    ? resolveSessionStorePathCore(cfg.session?.store, { agentId })
    : undefined;
  const entry = storePath
    ? await readSubagentSessionEntry(storePath, params.sessionKey, agentId)
    : undefined;

  const input = entry?.inputTokens;
  const output = entry?.outputTokens;
  const hasDirectionalUsage = typeof input === "number" || typeof output === "number";
  const ioTotal = (input ?? 0) + (output ?? 0);
  const promptCache = resolveFreshSessionTotalTokens(entry);
  const runtimeMs =
    typeof params.startedAt === "number" && typeof params.endedAt === "number"
      ? Math.max(0, params.endedAt - params.startedAt)
      : undefined;

  const parts = [
    `runtime ${formatDurationCompact(runtimeMs) ?? "n/a"}`,
    hasDirectionalUsage
      ? `tokens ${formatTokenCount(ioTotal)} (in ${formatTokenCount(input)} / out ${formatTokenCount(output)})`
      : promptCache === undefined
        ? "tokens unknown"
        : `tokens ${formatTokenCount(promptCache)} prompt/cache`,
  ];
  if (hasDirectionalUsage && typeof promptCache === "number" && promptCache > ioTotal) {
    parts.push(`prompt/cache ${formatTokenCount(promptCache)}`);
  }
  return `Stats: ${parts.join(" • ")}`;
}
