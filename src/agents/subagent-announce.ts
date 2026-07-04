/**
 * Subagent completion announcement coordinator.
 *
 * Captures child output, applies wait outcomes, routes announcements, and performs cleanup decisions.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../auto-reply/tokens.js";
import { buildDurableFanInSnapshotForChild } from "../durable/fan-in-snapshot.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveRequiredCompletionTerminalResult } from "../tasks/task-completion-contract.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
  runAnnounceDeliveryWithRetry,
  resolveSubagentAnnounceTimeoutMs,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-delivery.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  applySubagentWaitOutcome,
  buildChildCompletionFindings,
  buildCompactAnnounceStatsLine,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
  readLatestSubagentOutputWithRetry,
  readSubagentOutput,
  type SubagentRunOutcome,
  waitForSubagentRunOutcome,
} from "./subagent-announce-output.js";
import {
  callGateway,
  dispatchGatewayMethodInProcess,
  isEmbeddedAgentRunActive,
  getRuntimeConfig,
  waitForEmbeddedAgentRunEnd,
} from "./subagent-announce.runtime.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
import { isAnnounceSkip } from "./tools/sessions-send-tokens.js";

type SubagentAnnounceDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
};

type DirectChildCompletionRow = Parameters<
  typeof filterCurrentDirectChildCompletionRows
>[0][number];
type SiblingFanInFindings = {
  text: string;
  terminalCount: number;
  pendingCount: number;
  snapshotTruncated: boolean;
  allListedChildrenTerminal: boolean;
  currentChildOwnsFinal: boolean;
};

const defaultSubagentAnnounceDeps: SubagentAnnounceDeps = {
  callGateway,
  dispatchGatewayMethodInProcess,
  getRuntimeConfig,
  loadSubagentRegistryRuntime,
};

let subagentAnnounceDeps: SubagentAnnounceDeps = defaultSubagentAnnounceDeps;

const subagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-announce.registry.runtime.js"),
);

function loadSubagentRegistryRuntime() {
  return subagentRegistryRuntimeLoader.load();
}

export { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";
export { captureSubagentCompletionReply } from "./subagent-announce-output.js";
export type { SubagentRunOutcome } from "./subagent-announce-output.js";

export type SubagentAnnounceType = "subagent task" | "cron job";

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
}): string {
  if (params.requesterIsSubagent) {
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words. Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  if (params.expectsCompletionMessage) {
    return `A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type). Reply ONLY: ${SILENT_REPLY_TOKEN} only when this exact result is already visible to the user in this same turn.`;
  }
  return `A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}

function buildAnnounceSteerMessage(events: AgentInternalEvent[]): string {
  return (
    formatAgentInternalEventsForPrompt(events) ||
    "A background task finished. Process the completion update now."
  );
}

function hasUsableSessionEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const sessionId = (entry as { sessionId?: unknown }).sessionId;
  return typeof sessionId !== "string" || sessionId.trim() !== "";
}

function buildDescendantWakeMessage(params: { findings: string; taskLabel: string }): string {
  return [
    "[Subagent Context] Your prior run ended while waiting for descendant subagent completions.",
    "[Subagent Context] All pending descendants for that run have now settled.",
    "[Subagent Context] Continue your workflow using these results. Spawn more subagents if needed, otherwise send your final answer.",
    "",
    `Task: ${params.taskLabel}`,
    "",
    params.findings,
  ].join("\n");
}

const WAKE_RUN_SUFFIX = ":wake";

function stripWakeRunSuffixes(runId: string): string {
  let next = runId.trim();
  while (next.endsWith(WAKE_RUN_SUFFIX)) {
    next = next.slice(0, -WAKE_RUN_SUFFIX.length);
  }
  return next || runId.trim();
}

function isWakeContinuationRun(runId: string): boolean {
  const trimmed = runId.trim();
  if (!trimmed) {
    return false;
  }
  return stripWakeRunSuffixes(trimmed) !== trimmed;
}

function stripAndClassifyReply(text: string): string | null {
  let result = text;
  let didStrip = false;
  const hasLeadingSilentToken = startsWithSilentToken(result, SILENT_REPLY_TOKEN);
  if (hasLeadingSilentToken) {
    result = stripLeadingSilentToken(result, SILENT_REPLY_TOKEN);
    didStrip = true;
  }
  if (hasLeadingSilentToken || result.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())) {
    result = stripSilentToken(result, SILENT_REPLY_TOKEN);
    didStrip = true;
  }
  if (
    didStrip &&
    (!result.trim() || isSilentReplyText(result, SILENT_REPLY_TOKEN) || isAnnounceSkip(result))
  ) {
    return null;
  }
  return result;
}

const SIBLING_FAN_IN_WINDOW_MS = 30 * 60 * 1000;
const SIBLING_FAN_IN_MAX_ROWS = 8;

function asUsableTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasCompletionText(child: DirectChildCompletionRow): boolean {
  return Boolean(
    normalizeOptionalString(child.completion?.resultText) ??
    normalizeOptionalString(child.delivery?.payload?.frozenResultText) ??
    normalizeOptionalString(child.completion?.fallbackResultText) ??
    normalizeOptionalString(child.delivery?.payload?.fallbackFrozenResultText) ??
    normalizeOptionalString(child.frozenResultText),
  );
}

function isTerminalChildCompletionRow(child: DirectChildCompletionRow): boolean {
  const status = child.outcome?.status;
  return (
    status === "ok" ||
    status === "error" ||
    status === "timeout" ||
    typeof child.endedAt === "number"
  );
}

function patchCurrentChildCompletionRow(params: {
  child: DirectChildCompletionRow;
  currentChildRunId: string;
  currentFindings: string;
}): DirectChildCompletionRow {
  if (params.child.runId !== params.currentChildRunId || hasCompletionText(params.child)) {
    return params.child;
  }
  return {
    ...params.child,
    completion: {
      ...params.child.completion,
      resultText: params.currentFindings,
    },
  };
}

function buildSyntheticCurrentChildRow(params: {
  currentChildSessionKey: string;
  currentChildRunId: string;
  requesterSessionKey: string;
  task: string;
  label?: string;
  createdAt: number;
  endedAt?: number;
  currentFindings: string;
  outcome?: SubagentRunOutcome;
}): DirectChildCompletionRow {
  return {
    runId: params.currentChildRunId,
    childSessionKey: params.currentChildSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    task: params.task,
    label: params.label,
    createdAt: params.createdAt,
    endedAt: params.endedAt,
    outcome: params.outcome,
    completion: {
      resultText: params.currentFindings,
    },
  };
}

function compareChildCompletionFinalOwner(
  a: DirectChildCompletionRow,
  b: DirectChildCompletionRow,
): number {
  const aEnded = asUsableTimestamp(a.endedAt) ?? asUsableTimestamp(a.createdAt) ?? 0;
  const bEnded = asUsableTimestamp(b.endedAt) ?? asUsableTimestamp(b.createdAt) ?? 0;
  if (aEnded !== bEnded) {
    return aEnded - bEnded;
  }
  const aCreated = asUsableTimestamp(a.createdAt) ?? 0;
  const bCreated = asUsableTimestamp(b.createdAt) ?? 0;
  if (aCreated !== bCreated) {
    return aCreated - bCreated;
  }
  return a.runId.localeCompare(b.runId);
}

function buildRequesterSiblingFanInFindings(params: {
  registryRuntime: Awaited<ReturnType<typeof loadSubagentRegistryRuntime>> | undefined;
  requesterSessionKey: string;
  currentChildSessionKey: string;
  currentChildRunId: string;
  task: string;
  label?: string;
  startedAt?: number;
  endedAt?: number;
  currentFindings: string;
  outcome?: SubagentRunOutcome;
}): SiblingFanInFindings | undefined {
  if (
    !params.registryRuntime ||
    typeof params.registryRuntime.listSubagentRunsForRequester !== "function"
  ) {
    return undefined;
  }

  const allChildren = params.registryRuntime.listSubagentRunsForRequester(
    params.requesterSessionKey,
  );
  if (!Array.isArray(allChildren) || allChildren.length === 0) {
    return undefined;
  }

  const directChildren = filterCurrentDirectChildCompletionRows(allChildren, {
    requesterSessionKey: params.requesterSessionKey,
    getLatestSubagentRunByChildSessionKey:
      params.registryRuntime.getLatestSubagentRunByChildSessionKey,
  });
  const latestChildren = dedupeLatestChildCompletionRows(
    directChildren,
  ) as DirectChildCompletionRow[];
  const currentChild =
    latestChildren.find((child) => child.runId === params.currentChildRunId) ??
    latestChildren.find((child) => child.childSessionKey === params.currentChildSessionKey);
  const currentCreatedAt =
    asUsableTimestamp(currentChild?.createdAt) ??
    asUsableTimestamp(params.startedAt) ??
    asUsableTimestamp(params.endedAt) ??
    Date.now();

  const syntheticCurrent = buildSyntheticCurrentChildRow({
    currentChildSessionKey: params.currentChildSessionKey,
    currentChildRunId: params.currentChildRunId,
    requesterSessionKey: params.requesterSessionKey,
    task: params.task,
    label: params.label,
    createdAt: currentCreatedAt,
    endedAt: params.endedAt,
    currentFindings: params.currentFindings,
    outcome: params.outcome,
  });
  const latestByRunId = new Map<string, DirectChildCompletionRow>();
  for (const child of latestChildren) {
    latestByRunId.set(child.runId, child);
  }
  latestByRunId.set(
    params.currentChildRunId,
    latestByRunId.get(params.currentChildRunId) ?? syntheticCurrent,
  );

  const matchingCohort = [...latestByRunId.values()]
    .filter((child) => {
      const createdAt = asUsableTimestamp(child.createdAt) ?? currentCreatedAt;
      return Math.abs(createdAt - currentCreatedAt) <= SIBLING_FAN_IN_WINDOW_MS;
    })
    .toSorted((a, b) => {
      const aDistance = Math.abs(
        (asUsableTimestamp(a.createdAt) ?? currentCreatedAt) - currentCreatedAt,
      );
      const bDistance = Math.abs(
        (asUsableTimestamp(b.createdAt) ?? currentCreatedAt) - currentCreatedAt,
      );
      if (aDistance !== bDistance) {
        return aDistance - bDistance;
      }
      return (asUsableTimestamp(a.createdAt) ?? 0) - (asUsableTimestamp(b.createdAt) ?? 0);
    });
  const snapshotTruncated = matchingCohort.length > SIBLING_FAN_IN_MAX_ROWS;
  const cohort = matchingCohort
    .slice(0, SIBLING_FAN_IN_MAX_ROWS)
    .map((child) =>
      patchCurrentChildCompletionRow({
        child,
        currentChildRunId: params.currentChildRunId,
        currentFindings: params.currentFindings,
      }),
    )
    .toSorted(
      (a, b) => (asUsableTimestamp(a.createdAt) ?? 0) - (asUsableTimestamp(b.createdAt) ?? 0),
    );

  if (cohort.length < 2) {
    return undefined;
  }

  const findings = buildChildCompletionFindings(cohort);
  if (!findings?.trim()) {
    return undefined;
  }

  const terminalCount = cohort.filter(isTerminalChildCompletionRow).length;
  const pendingCount = Math.max(0, cohort.length - terminalCount);
  const finalOwner = [...cohort].toSorted(compareChildCompletionFinalOwner).at(-1);
  const text = [
    "Sibling fan-in snapshot (authoritative for this requester session):",
    `expected_children: ${cohort.length}`,
    `terminal_children: ${terminalCount}`,
    `pending_children: ${pendingCount}`,
    `snapshot_truncated: ${snapshotTruncated}`,
    "",
    findings,
  ].join("\n");
  return {
    text,
    terminalCount,
    pendingCount,
    snapshotTruncated,
    allListedChildrenTerminal: pendingCount === 0,
    currentChildOwnsFinal: finalOwner?.runId === params.currentChildRunId,
  };
}

async function wakeSubagentRunAfterDescendants(params: {
  runId: string;
  childSessionKey: string;
  taskLabel: string;
  findings: string;
  announceId: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }

  const childEntry = loadSessionEntryByKey(params.childSessionKey);
  if (!hasUsableSessionEntry(childEntry)) {
    return false;
  }

  const cfg = subagentAnnounceDeps.getRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const wakeMessage = buildDescendantWakeMessage({
    findings: params.findings,
    taskLabel: params.taskLabel,
  });

  let wakeRunId;
  try {
    const wakeResponse = await runAnnounceDeliveryWithRetry<{ runId?: string }>({
      operation: "descendant wake agent call",
      signal: params.signal,
      run: async () =>
        await subagentAnnounceDeps.dispatchGatewayMethodInProcess(
          "agent",
          {
            sessionKey: params.childSessionKey,
            message: wakeMessage,
            deliver: false,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: params.childSessionKey,
              sourceChannel: INTERNAL_MESSAGE_CHANNEL,
              sourceTool: "subagent_announce",
            },
            idempotencyKey: buildAnnounceIdempotencyKey(`${params.announceId}:wake`),
          },
          {
            timeoutMs: announceTimeoutMs,
          },
        ),
    });
    wakeRunId = normalizeOptionalString(wakeResponse?.runId) ?? "";
  } catch {
    return false;
  }

  if (!wakeRunId) {
    return false;
  }

  const { replaceSubagentRunAfterSteer } = await loadSubagentRegistryRuntime();
  return replaceSubagentRunAfterSteer({
    previousRunId: params.runId,
    nextRunId: wakeRunId,
    preserveFrozenResultFallback: true,
    // Persist the wake message as the replacement run's task so that any
    // post-restart redispatch reconstructs the correct prompt.
    task: wakeMessage,
  });
}

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  /**
   * Fallback text preserved from the pre-wake run when a wake continuation
   * completes with NO_REPLY despite an earlier final summary already existing.
   */
  fallbackReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
  announceType?: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  signal?: AbortSignal;
  bestEffortDeliver?: boolean;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  onBeforeDeleteChildSession?: () => boolean;
}): Promise<boolean> {
  let didAnnounce = false;
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  const announceType = params.announceType ?? "subagent task";
  let shouldDeleteChildSession = params.cleanup === "delete";
  try {
    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionId = (() => {
      const entry = loadSessionEntryByKey(params.childSessionKey);
      return typeof entry?.sessionId === "string" && entry.sessionId.trim()
        ? entry.sessionId.trim()
        : undefined;
    })();
    const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 120_000);
    let reply = params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    if (childSessionId && isEmbeddedAgentRunActive(childSessionId)) {
      const settled = await waitForEmbeddedAgentRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedAgentRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        // Keep delete cleanup retryable until the active child can be removed.
        if (outcome?.status !== "timeout" || params.cleanup === "delete") {
          return false;
        }
      }
    }

    if (!reply && params.waitForCompletion !== false) {
      const wait = await waitForSubagentRunOutcome(params.childRunId, settleTimeoutMs);
      const applied = applySubagentWaitOutcome({
        wait,
        outcome,
        startedAt: params.startedAt,
        endedAt: params.endedAt,
      });
      outcome = applied.outcome;
      params.startedAt = applied.startedAt;
      params.endedAt = applied.endedAt;
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }
    const failedTerminalOutcome = outcome.status === "error";
    const allowFailedOutputCapture =
      !failedTerminalOutcome || (!params.roundOneReply && !params.fallbackReply);
    if (failedTerminalOutcome) {
      reply = undefined;
    }
    let requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
    const requesterIsInternalSession = () =>
      requesterDepth >= 1 || isCronSessionKey(targetRequesterSessionKey);

    let childCompletionFindings: string | undefined;
    let subagentRegistryRuntime:
      | Awaited<ReturnType<typeof loadSubagentRegistryRuntime>>
      | undefined;
    try {
      subagentRegistryRuntime = await subagentAnnounceDeps.loadSubagentRegistryRuntime();
      if (
        requesterDepth >= 1 &&
        subagentRegistryRuntime.shouldIgnorePostCompletionAnnounceForSession(
          targetRequesterSessionKey,
        )
      ) {
        return true;
      }

      const pendingChildDescendantRuns = Math.max(
        0,
        subagentRegistryRuntime.countPendingDescendantRuns(params.childSessionKey),
      );
      if (pendingChildDescendantRuns > 0 && announceType !== "cron job") {
        shouldDeleteChildSession = false;
        return false;
      }

      if (typeof subagentRegistryRuntime.listSubagentRunsForRequester === "function") {
        const directChildren = subagentRegistryRuntime.listSubagentRunsForRequester(
          params.childSessionKey,
          {
            requesterRunId: params.childRunId,
          },
        );
        if (Array.isArray(directChildren) && directChildren.length > 0) {
          childCompletionFindings = buildChildCompletionFindings(
            dedupeLatestChildCompletionRows(
              filterCurrentDirectChildCompletionRows(directChildren, {
                requesterSessionKey: params.childSessionKey,
                getLatestSubagentRunByChildSessionKey:
                  subagentRegistryRuntime.getLatestSubagentRunByChildSessionKey,
              }),
            ),
          );
        }
      }
    } catch {
      // Best-effort only.
    }

    const announceId = buildAnnounceIdFromChildRun({
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
    });

    const childRunAlreadyWoken = isWakeContinuationRun(params.childRunId);
    if (
      params.wakeOnDescendantSettle === true &&
      childCompletionFindings?.trim() &&
      !childRunAlreadyWoken
    ) {
      const wakeAnnounceId = buildAnnounceIdFromChildRun({
        childSessionKey: params.childSessionKey,
        childRunId: stripWakeRunSuffixes(params.childRunId),
      });
      const woke = await wakeSubagentRunAfterDescendants({
        runId: params.childRunId,
        childSessionKey: params.childSessionKey,
        taskLabel: params.label || params.task || "task",
        findings: childCompletionFindings,
        announceId: wakeAnnounceId,
        signal: params.signal,
      });
      if (woke) {
        shouldDeleteChildSession = false;
        return true;
      }
    }

    if (!childCompletionFindings) {
      const fallbackReply = failedTerminalOutcome
        ? undefined
        : normalizeOptionalString(params.fallbackReply);
      const fallbackIsSilent =
        Boolean(fallbackReply) &&
        (isAnnounceSkip(fallbackReply) || isSilentReplyText(fallbackReply, SILENT_REPLY_TOKEN));

      if (!reply && allowFailedOutputCapture) {
        reply = await readSubagentOutput(params.childSessionKey, outcome);
      }

      if (!reply?.trim() && allowFailedOutputCapture) {
        reply = await readLatestSubagentOutputWithRetry({
          sessionKey: params.childSessionKey,
          maxWaitMs: params.timeoutMs,
          outcome,
        });
      }

      if (!reply?.trim() && fallbackReply && !fallbackIsSilent) {
        reply = fallbackReply;
      }

      // A worker can finish just after the first wait request timed out.
      // If we already have real completion content, do one cached recheck so
      // the final completion event prefers the authoritative terminal state.
      // This is best-effort; if the recheck fails, keep the known timeout
      // outcome instead of dropping the announcement entirely.
      if (outcome?.status === "timeout" && reply?.trim() && params.waitForCompletion !== false) {
        try {
          const rechecked = await waitForSubagentRunOutcome(params.childRunId, 0);
          const applied = applySubagentWaitOutcome({
            wait: rechecked,
            outcome,
            startedAt: params.startedAt,
            endedAt: params.endedAt,
          });
          outcome = applied.outcome;
          params.startedAt = applied.startedAt;
          params.endedAt = applied.endedAt;
        } catch {
          // Best-effort recheck; keep the existing timeout outcome on failure.
        }
      }

      if (isAnnounceSkip(reply) || isSilentReplyText(reply, SILENT_REPLY_TOKEN)) {
        if (fallbackReply && !fallbackIsSilent) {
          const cleaned = stripAndClassifyReply(fallbackReply);
          if (cleaned === null) {
            if (isAnnounceSkip(reply) && isCronSessionKey(targetRequesterSessionKey)) {
              logWarn(
                `cron job completion for session=${targetRequesterSessionKey} ` +
                  `run=${params.childRunId} suppressed by ANNOUNCE_SKIP; ` +
                  `the agent replied with the skip sentinel instead of delivering a result`,
              );
            }
            return true;
          }
          reply = cleaned;
        } else {
          if (isAnnounceSkip(reply) && isCronSessionKey(targetRequesterSessionKey)) {
            logWarn(
              `cron job completion for session=${targetRequesterSessionKey} ` +
                `run=${params.childRunId} suppressed by ANNOUNCE_SKIP; ` +
                `the agent replied with the skip sentinel instead of delivering a result`,
            );
          }
          return true;
        }
      } else if (reply) {
        const cleaned = stripAndClassifyReply(reply);
        if (cleaned === null) {
          if (fallbackReply && !fallbackIsSilent) {
            const cleanedFallback = stripAndClassifyReply(fallbackReply);
            if (cleanedFallback === null) {
              return true;
            }
            reply = cleanedFallback;
          } else {
            return true;
          }
        } else {
          reply = cleaned;
        }
      }
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    let requesterIsSubagent = requesterIsInternalSession();
    if (requesterIsSubagent) {
      const {
        isSubagentSessionRunActive,
        resolveRequesterForChildSession,
        shouldIgnorePostCompletionAnnounceForSession,
      } = subagentRegistryRuntime ?? (await loadSubagentRegistryRuntime());
      if (!isSubagentSessionRunActive(targetRequesterSessionKey)) {
        if (shouldIgnorePostCompletionAnnounceForSession(targetRequesterSessionKey)) {
          return true;
        }
        const parentSessionEntry = loadSessionEntryByKey(targetRequesterSessionKey);
        const parentSessionAlive = hasUsableSessionEntry(parentSessionEntry);

        if (!parentSessionAlive) {
          const fallback = resolveRequesterForChildSession(targetRequesterSessionKey);
          if (!fallback?.requesterSessionKey) {
            shouldDeleteChildSession = false;
            return false;
          }
          targetRequesterSessionKey = fallback.requesterSessionKey;
          targetRequesterOrigin =
            normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
          requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
          requesterIsSubagent = requesterIsInternalSession();
        }
      }
    }

    const taskLabel = params.label || params.task || "task";
    const announceSessionId = childSessionId || "unknown";
    const baseFindings = childCompletionFindings || reply || "(no output)";
    const durableFanIn = buildDurableFanInSnapshotForChild({
      childRunId: params.childRunId,
      childSessionKey: params.childSessionKey,
      currentFindings: baseFindings,
    });
    const legacySiblingFanIn = durableFanIn
      ? undefined
      : buildRequesterSiblingFanInFindings({
          registryRuntime: subagentRegistryRuntime,
          requesterSessionKey: targetRequesterSessionKey,
          currentChildSessionKey: params.childSessionKey,
          currentChildRunId: params.childRunId,
          task: params.task,
          label: params.label,
          startedAt: params.startedAt,
          endedAt: params.endedAt,
          currentFindings: baseFindings,
          outcome,
        });
    const fanInSnapshot = durableFanIn ?? legacySiblingFanIn;
    if (
      fanInSnapshot?.allListedChildrenTerminal &&
      !fanInSnapshot.snapshotTruncated &&
      !fanInSnapshot.currentChildOwnsFinal
    ) {
      return true;
    }
    const fanInFindings = fanInSnapshot?.text;
    const findings = fanInFindings || baseFindings;
    const terminalResult =
      expectsCompletionMessage && outcome.status === "ok"
        ? resolveRequiredCompletionTerminalResult(findings)
        : {};

    // Build status label
    const statusLabel =
      terminalResult.terminalOutcome === "blocked"
        ? `blocked: ${terminalResult.terminalSummary || "needs follow-up"}`
        : outcome.status === "ok"
          ? "completed; ready for parent review"
          : outcome.status === "timeout"
            ? "timed out"
            : outcome.status === "error"
              ? `failed: ${outcome.error || "unknown error"}`
              : "finished with unknown status";

    const replyInstruction = buildAnnounceReplyInstruction({
      requesterIsSubagent,
      announceType,
      expectsCompletionMessage,
    });
    const fanInRulePrefix = durableFanIn
      ? "Durable fan-in rule: Treat the durable fan-in snapshot above as authoritative for this parent fan-in group."
      : "Sibling fan-in rule: Treat the sibling fan-in snapshot above as authoritative for this requester session.";
    const effectiveReplyInstruction = fanInFindings
      ? [
          replyInstruction,
          [
            fanInRulePrefix,
            "If every expected child in the snapshot is terminal,",
            "and snapshot_truncated is false, synthesize the final parent answer now instead",
            "of saying a listed sibling is missing.",
            "If any child is still pending, report the partial state and the specific pending child.",
            "If snapshot_truncated is true, report partial state or query more sibling status instead of finalizing solely from the listed children.",
          ].join(" "),
        ].join("\n\n")
      : replyInstruction;
    const statsLine = await buildCompactAnnounceStatsLine({
      sessionKey: params.childSessionKey,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });
    const internalEvents: AgentInternalEvent[] = [
      {
        type: "task_completion",
        source: announceType === "cron job" ? "cron" : "subagent",
        childSessionKey: params.childSessionKey,
        childSessionId: announceSessionId,
        announceType,
        taskLabel,
        status: outcome.status,
        statusLabel,
        result: findings,
        statsLine,
        replyInstruction: effectiveReplyInstruction,
      },
    ];
    const triggerMessage = buildAnnounceSteerMessage(internalEvents);

    // Send to the requester session. For nested subagents this is an internal
    // follow-up injection (deliver=false) so the orchestrator receives it.
    let directOrigin = targetRequesterOrigin;
    if (!requesterIsSubagent) {
      const { entry } = loadRequesterSessionEntry(targetRequesterSessionKey);
      directOrigin = resolveAnnounceOrigin(entry, targetRequesterOrigin);
    }
    const completionDirectOrigin =
      expectsCompletionMessage && !requesterIsSubagent
        ? await resolveSubagentCompletionOrigin({
            childSessionKey: params.childSessionKey,
            requesterSessionKey: targetRequesterSessionKey,
            requesterOrigin: directOrigin,
            childRunId: params.childRunId,
            spawnMode: params.spawnMode,
            expectsCompletionMessage,
          })
        : targetRequesterOrigin;
    const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
    const delivery = await deliverSubagentAnnouncement({
      requesterSessionKey: targetRequesterSessionKey,
      announceId,
      triggerMessage,
      steerMessage: triggerMessage,
      internalEvents,
      summaryLine: taskLabel,
      requesterSessionOrigin: targetRequesterOrigin,
      requesterOrigin:
        expectsCompletionMessage && !requesterIsSubagent
          ? completionDirectOrigin
          : targetRequesterOrigin,
      completionDirectOrigin,
      directOrigin,
      sourceSessionKey: params.childSessionKey,
      sourceChannel: INTERNAL_MESSAGE_CHANNEL,
      sourceTool: "subagent_announce",
      targetRequesterSessionKey,
      requesterIsSubagent,
      expectsCompletionMessage,
      bestEffortDeliver: params.bestEffortDeliver,
      directIdempotencyKey,
      signal: params.signal,
    });
    params.onDeliveryResult?.(delivery);
    didAnnounce = delivery.delivered || delivery.terminal === true;
    if (!delivery.delivered && delivery.path === "direct" && delivery.error) {
      defaultRuntime.log(
        `[warn] Subagent completion direct announce failed for run ${params.childRunId}: ${delivery.error}`,
      );
    }
  } catch (err) {
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // Patch label after all writes complete
    if (params.label) {
      try {
        await subagentAnnounceDeps.callGateway({
          method: "sessions.patch",
          params: { key: params.childSessionKey, label: params.label },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort
      }
    }
    if (shouldDeleteChildSession && (params.onBeforeDeleteChildSession?.() ?? true)) {
      await deleteSubagentSessionForCleanup({
        callGateway: subagentAnnounceDeps.callGateway,
        childSessionKey: params.childSessionKey,
        spawnMode: params.spawnMode,
      });
    }
  }
  return didAnnounce;
}

export const testing = {
  setDepsForTest(
    overrides?: Partial<SubagentAnnounceDeps> & {
      callGateway?: typeof callGateway;
    },
  ) {
    const callGatewayOverride = overrides?.callGateway;
    const dispatchGatewayMethodInProcessOverride =
      overrides?.dispatchGatewayMethodInProcess ??
      (callGatewayOverride
        ? ((async (method, agentParams, options) =>
            await callGatewayOverride({
              method,
              params: agentParams,
              expectFinal: options?.expectFinal,
              timeoutMs: options?.timeoutMs,
            })) satisfies typeof dispatchGatewayMethodInProcess)
        : undefined);
    subagentAnnounceDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeps,
          ...overrides,
          ...(dispatchGatewayMethodInProcessOverride
            ? { dispatchGatewayMethodInProcess: dispatchGatewayMethodInProcessOverride }
            : {}),
        }
      : defaultSubagentAnnounceDeps;
  },
};
export { testing as __testing };
