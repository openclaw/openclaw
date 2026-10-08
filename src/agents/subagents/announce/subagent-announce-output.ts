import { formatCompactTokenCount } from "@openclaw/normalization-core";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  findTranscriptEvent,
  type SessionTranscriptRuntimeTarget,
} from "../../../config/sessions/session-accessor.js";
import { findSessionTranscriptArchiveEventReadOnly } from "../../../config/sessions/session-history.js";
import { resolveFreshSessionTotalTokens } from "../../../config/sessions/types.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
import { isContractToolCallBlock } from "../../../shared/tool-block-contract.js";
import type { AgentRunDisposition } from "../../internal-event-contract.js";
import { sleep } from "../../../utils/sleep.js";
import { extractStoredAssistantText } from "../../tools/chat-history-text.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunReadRecord } from "../registry/subagent-registry-read.types.js";
import { prepareSubagentRunsSnapshotForRunIds } from "../registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { isRequesterCompletionCohortCurrent } from "../registry/subagent-requester-settle-identity.js";
import { recordLatestSubagentRun } from "../registry/subagent-run-generation.js";
import {
  resolveSubagentRunDisposition,
  type SubagentRunOutcome,
} from "../subagent-terminal-outcome.js";
import {
  buildChildCompletionFindings,
  readSubagentRunAnnounceResultUsing,
  SubagentAnnouncePreparationConflictError,
  type ChildCompletionRow,
  type PreparedAnnounceResult,
} from "./subagent-announce-result.js";
import {
  callSubagentLifecycleGateway,
  getRuntimeConfig,
  readSubagentSessionEntry,
  readSessionMessagesAsync,
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "./subagent-announce.runtime.js";
import { assistantCallsSessionsYield, isSessionsYieldToolResult } from "./subagent-yield-output.js";

export {
  resolveSubagentRunDisposition,
  type SubagentRunOutcome,
} from "../subagent-terminal-outcome.js";

const FAST_TEST_RETRY_INTERVAL_MS = 8;

type SubagentOutputSnapshot = {
  latestText?: string;
  latestToolCallCount?: number;
  waitingForContinuation?: boolean;
};

/** True when the observation carries no confirmed child stop. */
export function isSubagentRunStillRunning(outcome: SubagentRunOutcome | undefined): boolean {
  return resolveSubagentRunDisposition(outcome) === "still-running";
}

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
  const { timeoutDisposition, ...canonicalOutcome } = outcome;
  return {
    ...canonicalOutcome,
    ...(timeoutDisposition ? { disposition: resolveSubagentRunDisposition(outcome) } : {}),
    ...nextTiming,
  };
}

function summarizeSubagentOutputHistory(messages: Array<unknown>): SubagentOutputSnapshot {
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
      previousAssistantCalledYield = assistantCallsSessionsYield(message);
      snapshot.waitingForContinuation = previousAssistantCalledYield;
      if (previousAssistantCalledYield) {
        snapshot.latestText = undefined;
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
    if (isSessionsYieldToolResult(message, previousAssistantCalledYield)) {
      snapshot.latestText = undefined;
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
  options?: { sessionTarget?: SessionTranscriptRuntimeTarget },
): Promise<string | undefined> {
  let messages: unknown[] | undefined;
  if (options?.sessionTarget) {
    messages = await readSessionMessagesAsync(options.sessionTarget, {
      mode: "recent",
      maxMessages: 100,
      maxBytes: 1024 * 1024,
    });
  }
  const history =
    messages === undefined
      ? await callSubagentLifecycleGateway({
          method: "chat.history",
          params: { sessionKey, limit: 100 },
        })
      : undefined;
  const sourceMessages = messages ?? (Array.isArray(history?.messages) ? history.messages : []);
  const snapshot = summarizeSubagentOutputHistory(sourceMessages);
  if (snapshot.waitingForContinuation) {
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
  maxWaitMs: number;
  outcome?: SubagentRunOutcome;
}): Promise<string | undefined> {
  return await readOutputWithRetry(
    params.maxWaitMs,
    isFastTestRuntimeEnv() ? FAST_TEST_RETRY_INTERVAL_MS : 100,
    () => readSubagentOutput(params.sessionKey, params.outcome),
  );
}

export async function readSubagentTimeoutProgress(
  sessionKey: string,
  maxWaitMs: number,
  outcome: SubagentRunOutcome,
): Promise<string | undefined> {
  const initial = await readSubagentOutput(sessionKey, outcome);
  const progress = initial?.trim()
    ? initial
    : await readLatestSubagentOutputWithRetry({ sessionKey, maxWaitMs, outcome });
  return progress && !isSilentReplyText(progress, SILENT_REPLY_TOKEN) ? progress : undefined;
}

export async function captureSubagentCompletionReply(
  sessionKey: string,
  options?: {
    waitForReply?: boolean;
    outcome?: SubagentRunOutcome;
    sessionTarget?: SessionTranscriptRuntimeTarget;
  },
): Promise<string | undefined> {
  const waitForReply = options?.waitForReply;
  const maxWaitMs = isFastTestRuntimeEnv() ? 50 : 1_500;
  const retryIntervalMs = isFastTestRuntimeEnv() ? FAST_TEST_RETRY_INTERVAL_MS : 100;
  const readOutput = () =>
    readSubagentOutput(sessionKey, options?.outcome, { sessionTarget: options?.sessionTarget });
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
    resolveAgentIdFromSessionKey,
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
      if (!child || !prepared.isCurrent()) {
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
      results.map(({ child, text }) => ({
        childSessionKey: child.childSessionKey,
        task: child.task,
        taskName: child.taskName,
        label: child.label,
        createdAt: child.createdAt,
        endedReason: child.endedReason,
        execution: child.execution,
        completion: child.completion,
        announceResult: text,
      })),
    ),
    isCurrent,
  };
}

export function dedupeLatestChildCompletionRows<
  T extends ChildCompletionRow & { runId: string; generation?: number },
>(children: T[]): T[] {
  const latestByChildSessionKey = new Map<string, (typeof children)[number]>();
  for (const child of children) {
    recordLatestSubagentRun(latestByChildSessionKey, child.childSessionKey, child);
  }
  return [...latestByChildSessionKey.values()];
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
  startedAt?: number;
  endedAt?: number;
  disposition?: AgentRunDisposition;
}) {
  const stillRunning = params.disposition === "still-running";
  const cfg = getRuntimeConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId,
  });
  let entry = readSubagentSessionEntry(storePath, params.sessionKey);
  const tokenWaitAttempts = isFastTestRuntimeEnv() ? 1 : 3;
  for (let attempt = 0; attempt < tokenWaitAttempts; attempt += 1) {
    if (
      typeof entry?.inputTokens === "number" ||
      typeof entry?.outputTokens === "number" ||
      resolveFreshSessionTotalTokens(entry) !== undefined
    ) {
      break;
    }
    if (!isFastTestRuntimeEnv()) {
      await sleep(150);
    }
    entry = readSubagentSessionEntry(storePath, params.sessionKey);
  }

  const input = entry?.inputTokens;
  const output = entry?.outputTokens;
  const hasDirectionalUsage = typeof input === "number" || typeof output === "number";
  const ioTotal = (input ?? 0) + (output ?? 0);
  const promptCache = resolveFreshSessionTotalTokens(entry);
  const runtimeMs =
    typeof params.startedAt === "number" && typeof params.endedAt === "number"
      ? Math.max(0, params.endedAt - params.startedAt)
      : undefined;

  // A live child has not flushed its usage counters, so a zeroed token total
  // reads as "the run did nothing" when it means "nothing is final yet". Label
  // both numbers by what they actually measure instead of publishing 0. For a
  // terminal run, fall back to prompt/cache totals (or say so) rather than
  // implying directional counts we never received.
  const parts = stillRunning
    ? [
        `waited ${formatDurationCompact(runtimeMs) ?? "n/a"}`,
        hasDirectionalUsage && ioTotal > 0
          ? `tokens so far ${formatTokenCount(ioTotal)} (in ${formatTokenCount(input)} / out ${formatTokenCount(output)})`
          : "child tokens not yet reported",
      ]
    : [
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
