import { formatCompactTokenCount } from "@openclaw/normalization-core";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
/**
 * Subagent completion output capture.
 *
 * Reads child session output, detects waiting states, and formats completion findings for announcements.
 */
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
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../../agent-run-terminal-outcome.js";
import { extractStoredAssistantText } from "../../tools/chat-history-text.js";
import { isAnnounceSkip } from "../../tools/sessions-send-tokens.js";
import { recordLatestSubagentRun } from "../registry/subagent-run-generation.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import { classifySubagentTerminalOutcome } from "../subagent-terminal-outcome.js";
import {
  captureSubagentCompletionReplyUsing,
  readLatestSubagentOutputWithRetryUsing,
} from "./subagent-announce-capture.js";
import {
  buildChildCompletionFindings,
  readSubagentRunAnnounceResultUsing,
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

const FAST_TEST_RETRY_INTERVAL_MS = 8;

type SubagentOutputSnapshot = {
  latestText?: string;
  latestToolCallCount?: number;
  waitingForContinuation?: boolean;
};

type AgentWaitResult = {
  status?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  pendingError?: boolean;
  timeoutPhase?: string;
  providerStarted?: boolean;
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

function countAssistantToolCalls(message: unknown): number {
  if (!message || typeof message !== "object") {
    return 0;
  }
  const content = (message as { content?: unknown }).content;
  const contentToolCalls = Array.isArray(content)
    ? content.filter((block) => isContractToolCallBlock(block)).length
    : 0;
  const toolCalls =
    (message as { toolCalls?: unknown; tool_calls?: unknown }).toolCalls ??
    (message as { tool_calls?: unknown }).tool_calls;
  return contentToolCalls + (Array.isArray(toolCalls) ? toolCalls.length : 0);
}

function summarizeSubagentOutputHistory(messages: Array<unknown>): SubagentOutputSnapshot {
  const snapshot: SubagentOutputSnapshot = {};
  let previousAssistantCalledYield = false;
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    const provenance = (message as { provenance?: unknown }).provenance;
    if (
      role === "user" ||
      (provenance &&
        typeof provenance === "object" &&
        !Array.isArray(provenance) &&
        (provenance as { kind?: unknown }).kind === "inter_session")
    ) {
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
      const toolCallCount = countAssistantToolCalls(message);
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

function selectSubagentOutputText(
  snapshot: SubagentOutputSnapshot,
  outcome?: SubagentRunOutcome,
): string | undefined {
  if (snapshot.waitingForContinuation) {
    return undefined;
  }
  if (snapshot.latestText) {
    return snapshot.latestText;
  }
  // Tool activity is partial-progress evidence only for a timed-out run. It is
  // not authoritative completion output when producer terminal facts are absent.
  if (
    outcome?.status === "timeout" &&
    snapshot.latestToolCallCount &&
    snapshot.latestToolCallCount > 0
  ) {
    return `${snapshot.latestToolCallCount} tool call(s) made without visible output.`;
  }
  return undefined;
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
  const selected = selectSubagentOutputText(snapshot, outcome);
  if (selected?.trim()) {
    return selected;
  }
  return undefined;
}

export async function readLatestSubagentOutputWithRetry(params: {
  sessionKey: string;
  maxWaitMs: number;
  outcome?: SubagentRunOutcome;
}): Promise<string | undefined> {
  return await readLatestSubagentOutputWithRetryUsing({
    sessionKey: params.sessionKey,
    maxWaitMs: params.maxWaitMs,
    outcome: params.outcome,
    retryIntervalMs: isFastTestRuntimeEnv() ? FAST_TEST_RETRY_INTERVAL_MS : 100,
    readSubagentOutput,
  });
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
  return progress && !isAnnounceSkip(progress) && !isSilentReplyText(progress, SILENT_REPLY_TOKEN)
    ? progress
    : undefined;
}

export async function waitForSubagentRunOutcome(
  runId: string,
  timeoutMs: number,
): Promise<AgentWaitResult> {
  const waitMs = Math.max(0, Math.floor(timeoutMs));
  return await callSubagentLifecycleGateway({
    method: "agent.wait",
    params: {
      runId,
      timeoutMs: waitMs,
    },
    timeoutMs: waitMs + 2000,
  });
}

export function applySubagentWaitOutcome(params: {
  wait: AgentWaitResult | undefined;
  outcome: SubagentRunOutcome | undefined;
  startedAt?: number;
  endedAt?: number;
}) {
  const next = {
    outcome: params.outcome,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
  };
  if (typeof params.wait?.startedAt === "number" && typeof next.startedAt !== "number") {
    next.startedAt = params.wait.startedAt;
  }
  if (typeof params.wait?.endedAt === "number" && typeof next.endedAt !== "number") {
    next.endedAt = params.wait.endedAt;
  }
  const waitError = typeof params.wait?.error === "string" ? params.wait.error : undefined;
  const terminalOutcome = buildAgentRunTerminalOutcomeFromWaitResult(params.wait);
  let outcome = next.outcome;
  // Capture/announcement callers can pass raw wait snapshots that bypass the
  // primary normalizers, so apply the canonical classification here instead
  // of re-enumerating reason groups.
  if (terminalOutcome) {
    // Keep main's subagent-specific classifier: it preserves explicit
    // restart/aborted stop reasons as cancellation while still letting real
    // provider timeouts through (openclaw#125407).
    switch (classifySubagentTerminalOutcome(terminalOutcome)) {
      case "timeout": {
        // A run that failed inside the lifecycle error retry grace window is
        // surfaced to waiters as a timeout carrying the failure text and
        // `pendingError: true` (see createPendingErrorTimeoutSnapshot). Keep
        // that cause so the announce can report why the child died instead of
        // a bare "timed out". Genuine budget timeouts have no pendingError and
        // stay unchanged.
        const pendingErrorText =
          params.wait?.pendingError === true ? (terminalOutcome.error ?? waitError) : undefined;
        outcome = pendingErrorText
          ? { status: "timeout", error: pendingErrorText }
          : { status: "timeout" };
        break;
      }
      case "cancellation":
        outcome = { status: "error", error: "subagent run terminated" };
        break;
      case "failure":
        outcome = { status: "error", error: terminalOutcome.error ?? waitError };
        break;
      case "success":
        outcome = { status: "ok" };
        break;
    }
  }
  next.outcome = outcome ? withSubagentOutcomeTiming(outcome, next) : undefined;
  return next;
}

export async function captureSubagentCompletionReply(
  sessionKey: string,
  options?: {
    waitForReply?: boolean;
    outcome?: SubagentRunOutcome;
    sessionTarget?: SessionTranscriptRuntimeTarget;
  },
): Promise<string | undefined> {
  return await captureSubagentCompletionReplyUsing({
    sessionKey,
    waitForReply: options?.waitForReply,
    maxWaitMs: isFastTestRuntimeEnv() ? 50 : 1_500,
    retryIntervalMs: isFastTestRuntimeEnv() ? FAST_TEST_RETRY_INTERVAL_MS : 100,
    readSubagentOutput: async (nextSessionKey) =>
      await readSubagentOutput(nextSessionKey, options?.outcome, {
        sessionTarget: options?.sessionTarget,
      }),
  });
}

export async function readSubagentRunAnnounceResult(
  child: Parameters<typeof readSubagentRunAnnounceResultUsing>[0],
): Promise<PreparedAnnounceResult> {
  return await readSubagentRunAnnounceResultUsing(child, {
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
  children: Array<ChildCompletionRow & { runId: string }>,
): Promise<PreparedAnnounceResult> {
  const results = await Promise.all(
    children.map(async (child) => ({
      child,
      ...(await readSubagentRunAnnounceResult(child)),
    })),
  );
  const isCurrent = () => results.every((result) => result.isCurrent());
  if (!isCurrent()) {
    throw new Error("A child result changed while preparing the completion batch.");
  }
  return {
    text: buildChildCompletionFindings(
      results.map(({ child, text }) => ({
        childSessionKey: child.childSessionKey,
        task: child.task,
        taskName: child.taskName,
        label: child.label,
        createdAt: child.createdAt,
        execution: child.execution,
        endedReason: child.endedReason,
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
    requesterSessionKey: string;
    requesterAgentId?: string;
  },
>(
  children: T[],
  params: {
    requesterSessionKey: string;
    requesterAgentId?: string;
    getLatestSubagentRunByChildSessionKey?: (childSessionKey: string) =>
      | {
          runId: string;
          requesterSessionKey: string;
          requesterAgentId?: string;
        }
      | null
      | undefined;
  },
): T[] {
  if (typeof params.getLatestSubagentRunByChildSessionKey !== "function") {
    return children;
  }
  return children.filter((child) => {
    const latest = params.getLatestSubagentRunByChildSessionKey?.(child.childSessionKey);
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
}) {
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
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
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
