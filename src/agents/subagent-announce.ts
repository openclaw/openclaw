import { consumePendingDelegates } from "../auto-reply/continuation-delegate-store.js";
import { resolveContinuationRuntimeConfig } from "../auto-reply/reply/continuation-runtime.js";
import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripContinuationSignal,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../auto-reply/tokens.js";
import {
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  updateSessionStore,
} from "../config/sessions.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
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
  isEmbeddedPiRunActive,
  loadConfig,
  waitForEmbeddedPiRunEnd,
} from "./subagent-announce.runtime.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
import { isAnnounceSkip } from "./tools/sessions-send-tokens.js";

type SubagentAnnounceDeps = {
  callGateway: typeof callGateway;
  loadConfig: typeof loadConfig;
  loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
};

const defaultSubagentAnnounceDeps: SubagentAnnounceDeps = {
  callGateway,
  loadConfig,
  loadSubagentRegistryRuntime,
};

let subagentAnnounceDeps: SubagentAnnounceDeps = defaultSubagentAnnounceDeps;

let subagentRegistryRuntimePromise: Promise<
  typeof import("./subagent-announce.registry.runtime.js")
> | null = null;
let continuationStateRuntimePromise: Promise<
  typeof import("../auto-reply/reply/continuation-state.runtime.js")
> | null = null;
let subagentSpawnRuntimePromise: Promise<
  Pick<typeof import("./subagent-spawn.js"), "spawnSubagentDirect">
> | null = null;

function loadSubagentRegistryRuntime() {
  subagentRegistryRuntimePromise ??= import("./subagent-announce.registry.runtime.js");
  return subagentRegistryRuntimePromise;
}

function loadContinuationStateRuntime() {
  continuationStateRuntimePromise ??= import("../auto-reply/reply/continuation-state.runtime.js");
  return continuationStateRuntimePromise;
}

function loadSubagentSpawnRuntime() {
  subagentSpawnRuntimePromise ??= import("./subagent-spawn.js");
  return subagentSpawnRuntimePromise;
}

export { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";
export { captureSubagentCompletionReply } from "./subagent-announce-output.js";
export type { SubagentRunOutcome } from "./subagent-announce-output.js";

export type SubagentAnnounceType = "subagent task" | "cron job";

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  silentEnrichment?: boolean;
  silentWakeEnrichment?: boolean;
}): string {
  if (params.requesterIsSubagent) {
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words. Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  if (params.expectsCompletionMessage) {
    return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type).`;
  }
  return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
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

  const cfg = subagentAnnounceDeps.loadConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const wakeMessage = buildDescendantWakeMessage({
    findings: params.findings,
    taskLabel: params.taskLabel,
  });

  let wakeRunId = "";
  try {
    const wakeResponse = await runAnnounceDeliveryWithRetry<{ runId?: string }>({
      operation: "descendant wake agent call",
      signal: params.signal,
      run: async () =>
        await subagentAnnounceDeps.callGateway({
          method: "agent",
          params: {
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
          timeoutMs: announceTimeoutMs,
        }),
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
  /** When true, deliver completion as a silent system event instead of a
   *  visible channel message. Used for ambient enrichment (DELEGATE | silent). */
  silentAnnounce?: boolean;
  /** When true (with silentAnnounce), trigger a generation cycle on the parent
   *  session after enrichment delivery. Enables autonomous cognition loops
   *  (DELEGATE | silent-wake). */
  wakeOnReturn?: boolean;
}): Promise<boolean> {
  let didAnnounce = false;
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  const announceType = params.announceType ?? "subagent task";
  let shouldDeleteChildSession = params.cleanup === "delete";
  try {
    const sessionEntryCache = new Map<string, ReturnType<typeof loadSessionEntryByKey>>();
    const requesterEntryCache = new Map<string, ReturnType<typeof loadRequesterSessionEntry>>();
    const readSessionEntryByKey = (sessionKey: string, options?: { refresh?: boolean }) => {
      if (options?.refresh || !sessionEntryCache.has(sessionKey)) {
        sessionEntryCache.set(sessionKey, loadSessionEntryByKey(sessionKey));
      }
      return sessionEntryCache.get(sessionKey);
    };
    const readRequesterSessionEntry = (
      requesterSessionKey: string,
      options?: { refresh?: boolean },
    ) => {
      if (options?.refresh || !requesterEntryCache.has(requesterSessionKey)) {
        requesterEntryCache.set(
          requesterSessionKey,
          loadRequesterSessionEntry(requesterSessionKey),
        );
      }
      return requesterEntryCache.get(requesterSessionKey)!;
    };
    const invalidateSessionEntry = (sessionKey: string) => {
      sessionEntryCache.delete(sessionKey);
      requesterEntryCache.delete(sessionKey);
    };

    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionId = (() => {
      const entry = readSessionEntryByKey(params.childSessionKey);
      return typeof entry?.sessionId === "string" && entry.sessionId.trim()
        ? entry.sessionId.trim()
        : undefined;
    })();
    const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 120_000);
    let reply = params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    if (childSessionId && isEmbeddedPiRunActive(childSessionId)) {
      const settled = await waitForEmbeddedPiRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedPiRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        return false;
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
      const runtime = subagentRegistryRuntime;
      const refreshRequesterTarget = () => {
        if (!requesterIsInternalSession()) {
          return { ok: true } as const;
        }
        if (runtime.isSubagentSessionRunActive(targetRequesterSessionKey)) {
          return { ok: true } as const;
        }
        if (runtime.shouldIgnorePostCompletionAnnounceForSession(targetRequesterSessionKey)) {
          return { ok: false, ignored: true } as const;
        }
        const parentSessionEntry = readSessionEntryByKey(targetRequesterSessionKey);
        if (hasUsableSessionEntry(parentSessionEntry)) {
          return { ok: true } as const;
        }
        const fallback = runtime.resolveRequesterForChildSession(targetRequesterSessionKey);
        if (!fallback?.requesterSessionKey) {
          return { ok: false, missing: true } as const;
        }
        targetRequesterSessionKey = fallback.requesterSessionKey;
        targetRequesterOrigin =
          normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
        requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
        return { ok: true } as const;
      };
      const requesterTarget = refreshRequesterTarget();
      if (!requesterTarget.ok) {
        if (requesterTarget.ignored) {
          return true;
        }
        shouldDeleteChildSession = false;
        return false;
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

    // Track whether the announce delivery should be skipped (silent/skip reply
    // with no fallback). Declared here so chain-hop accounting below still runs.
    let skipAnnounceDelivery = false;

    if (childCompletionFindings?.trim()) {
      // Descendant completions were synthesized successfully; announce that
      // result upward unless we converted it into a wake continuation above.
      reply = childCompletionFindings;
    } else if (!failedTerminalOutcome) {
      const fallbackReply = normalizeOptionalString(params.fallbackReply);
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
            return true;
          }
          reply = cleaned;
        } else {
          // Do NOT early-return here — fall through to chain-hop accounting
          // below so that token accumulation, chain guards, and tool-delegate
          // consumption still run for silent/skip replies. Without this,
          // subagents that reply with NO_REPLY bypass cost-cap enforcement
          // and chain-hop accounting entirely (Swim 8, 8-T6 finding).
          skipAnnounceDelivery = true;
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

    // Build status label
    const statusLabel =
      outcome.status === "ok"
        ? "completed successfully"
        : outcome.status === "timeout"
          ? "timed out"
          : outcome.status === "error"
            ? `failed: ${outcome.error || "unknown error"}`
            : "finished with unknown status";

    const taskLabel = params.label || params.task || "task";
    const announceSessionId = childSessionId || "unknown";
    let findings = reply || "(no output)";
    if (
      childCompletionFindings?.trim() &&
      findings !== "(no output)" &&
      findings !== childCompletionFindings
    ) {
      findings = `${findings}\n\n[Descendant completions]\n${childCompletionFindings}`;
    }

    // --- Sub-agent continuation chain: accumulate child token cost + parse [[CONTINUE_DELEGATE:]] ---
    const cfg = loadConfig();
    const continuationEnabled = cfg?.agents?.defaults?.continuation?.enabled === true;

    // Accumulate the completing shard's token cost unconditionally on delegate-return,
    // even if the child doesn't emit another [[CONTINUE_DELEGATE:]]. Without this,
    // children that finish normally leak their tokens from the chain budget.
    const childTask = params.task ?? "";
    const isContinuationChainDelegate = /\[continuation:chain-hop:\d+\]/.test(childTask);
    let accumulatedChildTokens = 0;
    if (continuationEnabled && isContinuationChainDelegate) {
      let childEntry = readSessionEntryByKey(params.childSessionKey);
      const hasTokenData =
        typeof childEntry?.inputTokens === "number" || typeof childEntry?.outputTokens === "number";
      if (!hasTokenData) {
        // Best-effort single retry — avoid blocking the announce hot path
        await new Promise((resolve) => setTimeout(resolve, 150));
        childEntry = readSessionEntryByKey(params.childSessionKey, { refresh: true });
        const hasTokenDataRetry =
          typeof childEntry?.inputTokens === "number" ||
          typeof childEntry?.outputTokens === "number";
        if (!hasTokenDataRetry) {
          defaultRuntime.log(
            `[subagent-chain-hop] Token data unavailable for ${params.childSessionKey} after retry, proceeding with zero token accumulation`,
          );
        }
      }
      accumulatedChildTokens =
        (typeof childEntry?.inputTokens === "number" ? childEntry.inputTokens : 0) +
        (typeof childEntry?.outputTokens === "number" ? childEntry.outputTokens : 0);
      if (accumulatedChildTokens > 0) {
        const parentAgentId = resolveAgentIdFromSessionKey(targetRequesterSessionKey);
        const parentStorePath = resolveStorePath(cfg?.session?.store, {
          agentId: parentAgentId,
        });
        try {
          await updateSessionStore(parentStorePath, (store) => {
            const parentEntry = store[targetRequesterSessionKey];
            if (parentEntry) {
              const prev =
                typeof parentEntry.continuationChainTokens === "number"
                  ? parentEntry.continuationChainTokens
                  : 0;
              parentEntry.continuationChainTokens = prev + accumulatedChildTokens;
            }
          });
          defaultRuntime.log(
            `[subagent-chain-hop] Accumulated ${accumulatedChildTokens} tokens from ${params.childSessionKey} to parent chain cost`,
          );
          invalidateSessionEntry(targetRequesterSessionKey);
        } catch (err) {
          defaultRuntime.log(
            `[subagent-chain-hop] Failed to persist token accumulation for ${targetRequesterSessionKey}: ${String(err)}`,
          );
        }
      }
    }

    // --- Consume tool-dispatched delegates from the completing subagent ---
    const toolDelegates =
      continuationEnabled && isContinuationChainDelegate
        ? consumePendingDelegates(params.childSessionKey)
        : [];
    if (toolDelegates.length > 0) {
      defaultRuntime.log(
        `[subagent-chain-hop] Consuming ${toolDelegates.length} tool delegate(s) from subagent ${params.childSessionKey}`,
      );
    }

    // Safety: drain orphaned delegates from non-chain-hop subagents that had tool access.
    if (!isContinuationChainDelegate && continuationEnabled) {
      const orphaned = consumePendingDelegates(params.childSessionKey);
      if (orphaned.length > 0) {
        defaultRuntime.log(
          `[subagent-chain-hop] WARNING: ${orphaned.length} tool delegate(s) orphaned from non-chain-hop subagent ${params.childSessionKey} — drainsContinuationDelegateQueue was set but task has no chain-hop prefix`,
        );
      }
    }

    // Track whether a bracket delegate was consumed from findings — must
    // capture BEFORE stripping mutates findings (P0-1 from review).
    let bracketDelegateConsumed = false;

    if (continuationEnabled && (findings !== "(no output)" || toolDelegates.length > 0)) {
      const continuationResult = stripContinuationSignal(findings);
      if (continuationResult.signal?.kind === "work") {
        defaultRuntime.log(
          `[subagent-chain-hop] CONTINUE_WORK not supported in sub-agent chain (from ${params.childSessionKey}), ignoring`,
        );
      } else if (continuationResult.signal?.kind === "delegate") {
        bracketDelegateConsumed = true;
        findings = continuationResult.text || "(no output)";
        const chainTask = continuationResult.signal.task;
        const chainDelayMs = continuationResult.signal.delayMs;
        const parentWasSilent = params.silentAnnounce === true;
        const chainSilent =
          continuationResult.signal.silent ||
          continuationResult.signal.silentWake ||
          parentWasSilent;
        const chainWake =
          continuationResult.signal.silentWake || (parentWasSilent && params.wakeOnReturn === true);

        const { maxChainLength, costCapTokens, minDelayMs, maxDelayMs } =
          resolveContinuationRuntimeConfig(cfg);

        const hopMatch = childTask.match(/\[continuation:chain-hop:(\d+)\]/);
        const childChainHop = hopMatch ? Number.parseInt(hopMatch[1], 10) : 0;
        const nextChainHop = childChainHop + 1;

        let chainGuardResult:
          | { allowed: false; reason: "chain-length"; chainCount: number; maxChainLength: number }
          | { allowed: false; reason: "cost-cap"; chainTokens: number; costCapTokens: number }
          | { allowed: true; nextChainHop: number };

        if (childChainHop >= maxChainLength) {
          chainGuardResult = {
            allowed: false,
            reason: "chain-length",
            chainCount: nextChainHop,
            maxChainLength,
          };
        } else {
          const parentEntry = readSessionEntryByKey(targetRequesterSessionKey);
          const storedChainTokens = parentEntry?.continuationChainTokens ?? 0;
          const parentChainTokens =
            storedChainTokens >= accumulatedChildTokens
              ? storedChainTokens
              : storedChainTokens + accumulatedChildTokens;
          if (costCapTokens > 0 && parentChainTokens > costCapTokens) {
            chainGuardResult = {
              allowed: false,
              reason: "cost-cap",
              chainTokens: parentChainTokens,
              costCapTokens,
            };
          } else {
            chainGuardResult = { allowed: true, nextChainHop };
          }
        }

        if (!chainGuardResult.allowed) {
          if (chainGuardResult.reason === "chain-length") {
            defaultRuntime.log(
              `[subagent-chain-hop] Chain length ${chainGuardResult.chainCount} > ${chainGuardResult.maxChainLength}, rejecting hop from ${params.childSessionKey}`,
            );
          } else {
            defaultRuntime.log(
              `[subagent-chain-hop] Cost cap exceeded (${chainGuardResult.chainTokens} > ${chainGuardResult.costCapTokens}), rejecting hop from ${params.childSessionKey}`,
            );
          }
        } else {
          const nextChainHop = chainGuardResult.nextChainHop;
          const continuationStateRuntime = await loadContinuationStateRuntime();

          continuationStateRuntime.setDelegatePending(targetRequesterSessionKey);

          const doChainSpawn = async (timerTriggered = false) => {
            try {
              const childDepth = getSubagentDepthFromSessionStore(params.childSessionKey);
              const { spawnSubagentDirect } = await loadSubagentSpawnRuntime();
              const spawnResult = await spawnSubagentDirect(
                {
                  task: `[continuation:chain-hop:${nextChainHop}] Delegated from sub-agent (depth ${childDepth}): ${chainTask}`,
                  ...(chainSilent ? { silentAnnounce: true } : {}),
                  ...(chainWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
                  drainsContinuationDelegateQueue: true,
                },
                {
                  agentSessionKey: targetRequesterSessionKey,
                  agentChannel: targetRequesterOrigin?.channel ?? undefined,
                  agentAccountId: targetRequesterOrigin?.accountId ?? undefined,
                  agentTo: targetRequesterOrigin?.to ?? undefined,
                  agentThreadId: targetRequesterOrigin?.threadId ?? undefined,
                },
              );
              if (spawnResult.status === "accepted") {
                defaultRuntime.log(
                  timerTriggered
                    ? `[subagent-chain-hop] Timer fired and spawned chain delegate (${nextChainHop}/${maxChainLength}) from ${params.childSessionKey}: ${chainTask.slice(0, 80)}`
                    : `[subagent-chain-hop] Spawned chain delegate (${nextChainHop}/${maxChainLength}) from ${params.childSessionKey}: ${chainTask.slice(0, 80)}`,
                );
              } else {
                defaultRuntime.log(
                  `[subagent-chain-hop] Spawn rejected (${spawnResult.status}) from ${params.childSessionKey}: ${chainTask.slice(0, 80)}`,
                );
              }
            } catch (err) {
              defaultRuntime.log(
                `[subagent-chain-hop] Spawn failed from ${params.childSessionKey}: ${String(err)}`,
              );
            }
          };

          if (chainDelayMs && chainDelayMs > 0) {
            const clampedDelay = Math.max(minDelayMs, Math.min(maxDelayMs, chainDelayMs));
            continuationStateRuntime.retainContinuationTimerRef(targetRequesterSessionKey);
            const timerHandle = setTimeout(() => {
              try {
                doChainSpawn(true).catch((err) => {
                  defaultRuntime.log(
                    `[subagent-chain-hop] Unhandled bracket delegate spawn error from ${params.childSessionKey}: ${String(err)}`,
                  );
                });
              } finally {
                continuationStateRuntime.unregisterContinuationTimerHandle(
                  targetRequesterSessionKey,
                  timerHandle,
                );
              }
            }, clampedDelay);
            continuationStateRuntime.registerContinuationTimerHandle(
              targetRequesterSessionKey,
              timerHandle,
            );
            timerHandle.unref();
          } else {
            // Fire-and-forget — don't block the announce flow
            doChainSpawn().catch((err) => {
              defaultRuntime.log(
                `[subagent-chain-hop] Unhandled bracket delegate spawn error from ${params.childSessionKey}: ${String(err)}`,
              );
            });
          }
        }
      }

      // --- Tool-dispatched delegates from subagent (parallel to bracket delegates above) ---
      if (toolDelegates.length > 0 && isContinuationChainDelegate) {
        const {
          maxChainLength: toolMaxChainLength,
          costCapTokens: toolCostCapTokens,
          minDelayMs: toolMinDelayMs,
          maxDelayMs: toolMaxDelayMs,
        } = resolveContinuationRuntimeConfig(cfg);
        const hopMatch = childTask.match(/\[continuation:chain-hop:(\d+)\]/);
        const childChainHop = hopMatch ? Number.parseInt(hopMatch[1], 10) : 0;
        // Use the flag captured before findings was mutated (not re-parsing stripped text).
        const bracketConsumedHop = bracketDelegateConsumed ? 1 : 0;
        let toolHopBase = childChainHop + bracketConsumedHop;

        const parentWasSilent = params.silentAnnounce === true;

        let toolDelegateIdx = 0;
        for (const toolDelegate of toolDelegates) {
          const nextToolHop = toolHopBase + 1;

          if (nextToolHop > toolMaxChainLength) {
            const remaining = toolDelegates.length - toolDelegateIdx;
            defaultRuntime.log(
              `[subagent-chain-hop] Tool delegate chain length ${nextToolHop} > ${toolMaxChainLength}, rejecting from ${params.childSessionKey}. ${remaining} delegate(s) dropped.`,
            );
            break;
          }

          const parentEntryForTool = readSessionEntryByKey(targetRequesterSessionKey);
          const storedToolChainTokens = parentEntryForTool?.continuationChainTokens ?? 0;
          const parentChainTokensForTool =
            storedToolChainTokens >= accumulatedChildTokens
              ? storedToolChainTokens
              : storedToolChainTokens + accumulatedChildTokens;
          if (toolCostCapTokens > 0 && parentChainTokensForTool > toolCostCapTokens) {
            const remaining = toolDelegates.length - toolDelegateIdx;
            defaultRuntime.log(
              `[subagent-chain-hop] Tool delegate cost cap exceeded (${parentChainTokensForTool} > ${toolCostCapTokens}), rejecting from ${params.childSessionKey}. ${remaining} delegate(s) dropped.`,
            );
            break;
          }

          const toolSilent = toolDelegate.silent || toolDelegate.silentWake || parentWasSilent;
          const toolWake =
            toolDelegate.silentWake || (parentWasSilent && params.wakeOnReturn === true);
          const toolDelayMs = toolDelegate.delayMs;
          const continuationStateRuntime = await loadContinuationStateRuntime();

          continuationStateRuntime.setDelegatePending(targetRequesterSessionKey);

          const childDepth = getSubagentDepthFromSessionStore(params.childSessionKey);
          const doToolChainSpawn = async (timerTriggered = false) => {
            try {
              const { spawnSubagentDirect } = await loadSubagentSpawnRuntime();
              const spawnResult = await spawnSubagentDirect(
                {
                  task: `[continuation:chain-hop:${nextToolHop}] Tool-delegated from sub-agent (depth ${childDepth}): ${toolDelegate.task}`,
                  ...(toolSilent ? { silentAnnounce: true } : {}),
                  ...(toolWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
                  drainsContinuationDelegateQueue: true,
                },
                {
                  agentSessionKey: targetRequesterSessionKey,
                  agentChannel: targetRequesterOrigin?.channel ?? undefined,
                  agentAccountId: targetRequesterOrigin?.accountId ?? undefined,
                  agentTo: targetRequesterOrigin?.to ?? undefined,
                  agentThreadId: targetRequesterOrigin?.threadId ?? undefined,
                },
              );
              if (spawnResult.status === "accepted") {
                defaultRuntime.log(
                  `[subagent-chain-hop] ${timerTriggered ? "Timer: " : ""}Tool delegate (${nextToolHop}/${toolMaxChainLength}) from ${params.childSessionKey}: ${toolDelegate.task.slice(0, 80)}`,
                );
              } else {
                defaultRuntime.log(
                  `[subagent-chain-hop] Tool delegate spawn rejected (${spawnResult.status}) from ${params.childSessionKey}`,
                );
              }
            } catch (err) {
              defaultRuntime.log(
                `[subagent-chain-hop] Tool delegate spawn failed from ${params.childSessionKey}: ${String(err)}`,
              );
            }
          };

          if (toolDelayMs && toolDelayMs > 0) {
            const clampedDelay = Math.max(toolMinDelayMs, Math.min(toolMaxDelayMs, toolDelayMs));
            continuationStateRuntime.retainContinuationTimerRef(targetRequesterSessionKey);
            const timerHandle = setTimeout(() => {
              try {
                doToolChainSpawn(true).catch((err) => {
                  defaultRuntime.log(
                    `[subagent-chain-hop] Unhandled tool delegate spawn error from ${params.childSessionKey}: ${String(err)}`,
                  );
                });
              } finally {
                continuationStateRuntime.unregisterContinuationTimerHandle(
                  targetRequesterSessionKey,
                  timerHandle,
                );
              }
            }, clampedDelay);
            continuationStateRuntime.registerContinuationTimerHandle(
              targetRequesterSessionKey,
              timerHandle,
            );
            timerHandle.unref();
          } else {
            doToolChainSpawn().catch((err) => {
              defaultRuntime.log(
                `[subagent-chain-hop] Unhandled tool delegate spawn error from ${params.childSessionKey}: ${String(err)}`,
              );
            });
          }

          toolHopBase = nextToolHop;
          toolDelegateIdx += 1;
        }
      }
    }

    // If the reply was silent/skip and we fell through for chain-hop accounting,
    // return now before delivery logic.
    if (skipAnnounceDelivery) {
      return true;
    }

    const requesterIsSubagent = requesterIsInternalSession();

    const replyInstruction = buildAnnounceReplyInstruction({
      requesterIsSubagent,
      announceType,
      expectsCompletionMessage,
      silentEnrichment: params.silentAnnounce === true,
      silentWakeEnrichment: params.silentAnnounce === true && params.wakeOnReturn === true,
    });
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
        replyInstruction,
      },
    ];
    const triggerMessage = buildAnnounceSteerMessage(internalEvents);

    // Send to the requester session. For nested subagents this is an internal
    // follow-up injection (deliver=false) so the orchestrator receives it.
    let directOrigin = targetRequesterOrigin;
    if (!requesterIsSubagent) {
      const { entry } = readRequesterSessionEntry(targetRequesterSessionKey);
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
    // Structured completion wakes are enabled fleet-wide through the same
    // continuation flag, even for ordinary subagent returns.
    const delegateReturnTrigger = continuationEnabled ? "delegate-return" : undefined;
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
      expectsCompletionMessage: expectsCompletionMessage,
      bestEffortDeliver: params.bestEffortDeliver,
      directIdempotencyKey,
      signal: params.signal,
      continuationTriggerOverride: delegateReturnTrigger,
    });
    didAnnounce = delivery.delivered;
    if (!delivery.delivered && delivery.path === "direct" && delivery.error) {
      defaultRuntime.error?.(
        `Subagent completion direct announce failed for run ${params.childRunId}: ${delivery.error}`,
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
    if (shouldDeleteChildSession) {
      try {
        await subagentAnnounceDeps.callGateway({
          method: "sessions.delete",
          params: {
            key: params.childSessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: params.spawnMode === "session",
          },
          timeoutMs: 10_000,
        });
      } catch {
        // ignore
      }
    }
  }
  return didAnnounce;
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentAnnounceDeps>) {
    subagentAnnounceDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeps,
          ...overrides,
        }
      : defaultSubagentAnnounceDeps;
  },
};
