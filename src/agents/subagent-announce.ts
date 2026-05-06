import { consumePendingDelegates } from "../auto-reply/continuation-delegate-store.js";
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
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { importRuntimeModule } from "../shared/runtime-import.js";
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
  isEmbeddedPiRunActive,
  getRuntimeConfig,
  resolveContinuationRuntimeConfig,
  waitForEmbeddedPiRunEnd,
} from "./subagent-announce.runtime.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
import { isAnnounceSkip } from "./tools/sessions-send-tokens.js";

type SubagentAnnounceDeps = {
  callGateway: typeof callGateway;
  getRuntimeConfig: typeof getRuntimeConfig;
  loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
  resolveContinuationRuntimeConfig: typeof resolveContinuationRuntimeConfig;
};

const defaultSubagentAnnounceDeps: SubagentAnnounceDeps = {
  callGateway,
  getRuntimeConfig,
  loadSubagentRegistryRuntime,
  resolveContinuationRuntimeConfig,
};

let subagentAnnounceDeps: SubagentAnnounceDeps = defaultSubagentAnnounceDeps;

let continuationStateRuntimePromise: Promise<
  typeof import("../auto-reply/continuation/state.js")
> | null = null;
let subagentSpawnRuntimePromise: Promise<
  Pick<typeof import("./subagent-spawn.js"), "spawnSubagentDirect">
> | null = null;
const CONTINUATION_CHAIN_HOP_PATTERN = /\[continuation:chain-hop:(\d+)\]/;

function resolveCompletionTraceContext(params: {
  traceparent?: string;
  task: string;
  resolveMaxChainLength: () => number;
}): { traceparent?: string; chainStepRemaining?: number } {
  if (!params.traceparent) {
    return {};
  }
  const hopMatch = params.task.match(CONTINUATION_CHAIN_HOP_PATTERN);
  if (!hopMatch) {
    return { traceparent: params.traceparent };
  }
  const childChainHop = Number.parseInt(hopMatch[1], 10);
  if (!Number.isFinite(childChainHop)) {
    return { traceparent: params.traceparent };
  }
  const chainStepRemaining = Math.max(0, params.resolveMaxChainLength() - childChainHop);
  return {
    chainStepRemaining,
    ...(chainStepRemaining > 0 ? { traceparent: params.traceparent } : {}),
  };
}

const subagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-announce.registry.runtime.js"),
);

function loadSubagentRegistryRuntime() {
  return subagentRegistryRuntimeLoader.load();
}

function loadContinuationStateRuntime() {
  continuationStateRuntimePromise ??= import("../auto-reply/continuation/state.js");
  return continuationStateRuntimePromise;
}

function loadSubagentSpawnRuntime() {
  subagentSpawnRuntimePromise ??= import("./subagent-spawn.js");
  return subagentSpawnRuntimePromise;
}

async function listKnownSessionKeysOnHost(
  cfg: ReturnType<typeof getRuntimeConfig>,
): Promise<string[]> {
  const [{ resolveAllAgentSessionStoreTargetsSync }, { loadSessionStore }] = await Promise.all([
    import("../config/sessions/targets.js"),
    import("../config/sessions/store-load.js"),
  ]);
  const keys = new Set<string>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    const store = loadSessionStore(target.storePath);
    for (const key of Object.keys(store)) {
      const normalized = normalizeOptionalString(key);
      if (normalized) {
        keys.add(normalized);
      }
    }
  }
  return [...keys].toSorted();
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

// Structural shapes for the continuation modules loaded via
// `importRuntimeModule`. Defined locally so no static edge leads from this
// file to `auto-reply/continuation/*` — that would close an import cycle
// through `delegate-dispatch → subagent-spawn → subagent-registry →
// subagent-announce`.
type ContinuationChainState = {
  currentChainCount: number;
  chainStartedAt: number;
  accumulatedChainTokens: number;
};

type ContinuationDispatchContext = {
  sessionKey: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
};

type ContinuationDispatchModule = {
  dispatchToolDelegates: (params: {
    sessionKey: string;
    chainState: ContinuationChainState;
    ctx: ContinuationDispatchContext;
    maxChainLength: number;
  }) => Promise<{
    dispatched: number;
    rejected: number;
    chainState: ContinuationChainState;
  }>;
};

type ContinuationChainSource = {
  continuationChainCount?: number;
  continuationChainStartedAt?: number;
  continuationChainTokens?: number;
};

type ContinuationStateModule = {
  loadContinuationChainState: (
    source: ContinuationChainSource | undefined,
    turnTokens?: number,
  ) => ContinuationChainState;
  persistContinuationChainState: (params: {
    sessionEntry?: ContinuationChainSource;
    count: number;
    startedAt: number;
    tokens: number;
  }) => void;
};

type SessionStoreUpdateModule = {
  updateSessionStore: <T>(
    storePath: string,
    mutator: (
      store: Record<string, ContinuationChainSource & Record<string, unknown>>,
    ) => Promise<T> | T,
  ) => Promise<T>;
  resolveStorePath: (store: unknown, options: { agentId: string }) => string;
  resolveAgentIdFromSessionKey: (sessionKey: string) => string;
};

/**
 * Drain the child session's continue_delegate queue after the subagent has
 * settled. Chain state is inherited from the child session entry so nested
 * hops stay sequential across the chain. Best-effort — dispatch failures
 * are logged and swallowed so they cannot break the announce path.
 */
async function drainChildContinuationQueue(params: {
  childSessionKey: string;
  requesterOrigin?: DeliveryContext;
}): Promise<void> {
  let cfg: ReturnType<typeof subagentAnnounceDeps.getRuntimeConfig>;
  try {
    cfg = subagentAnnounceDeps.getRuntimeConfig();
  } catch (err) {
    // Config-load failure here silently drops the child's delegate drain.
    // Surface it via the file's existing defaultRuntime.error
    // pattern so operators can see why a chain stopped after a subagent
    // settled.
    defaultRuntime.error?.(
      `[continuation:drain-config-load-failed] child=${params.childSessionKey} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (cfg?.agents?.defaults?.continuation?.enabled !== true) {
    return;
  }
  try {
    // `importRuntimeModule` constructs the module URL at call time, keeping
    // `delegate-dispatch.js` off the static import graph. Direct `await import()`
    // with a literal path would pull `subagent-spawn.js` into a cycle via
    // `delegate-dispatch.js → subagent-spawn.js → subagent-registry.js →
    // subagent-announce.ts`.
    const [dispatchModule, stateModule, sessionStoreModule] = await Promise.all([
      importRuntimeModule<ContinuationDispatchModule>(import.meta.url, [
        "./subagent-announce.continuation.runtime",
        ".js",
      ]),
      importRuntimeModule<ContinuationStateModule>(import.meta.url, [
        "./subagent-announce.continuation.runtime",
        ".js",
      ]),
      importRuntimeModule<SessionStoreUpdateModule>(import.meta.url, [
        "./subagent-announce.continuation.runtime",
        ".js",
      ]),
    ]);
    const { dispatchToolDelegates } = dispatchModule;
    const { loadContinuationChainState, persistContinuationChainState } = stateModule;
    const { updateSessionStore, resolveStorePath, resolveAgentIdFromSessionKey } =
      sessionStoreModule;
    const childEntry = loadSessionEntryByKey(params.childSessionKey) as
      | ContinuationChainSource
      | undefined;
    const dispatchConfig = subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg);
    const dispatchResult = await dispatchToolDelegates({
      sessionKey: params.childSessionKey,
      chainState: loadContinuationChainState(childEntry),
      ctx: {
        sessionKey: params.childSessionKey,
        agentChannel: params.requesterOrigin?.channel,
        agentAccountId: params.requesterOrigin?.accountId,
        agentTo: params.requesterOrigin?.to,
        agentThreadId: params.requesterOrigin?.threadId,
      },
      maxChainLength: dispatchConfig.maxChainLength,
    });

    // Persist the advanced child chain state after delegate drain. Without
    // this, child `continuationChainCount/StartedAt/Tokens`
    // never advances after accepted spawns; later drains reload stale
    // counters and under-enforce `maxChainLength`. Mirror the agent-runner
    // and followup-runner persist patterns.
    if (dispatchResult && dispatchResult.dispatched > 0) {
      const advanced = dispatchResult.chainState;
      const childEntryForWrite = childEntry as
        | (ContinuationChainSource & Record<string, unknown>)
        | undefined;
      // In-memory mirror so any post-drain reads of the same entry see the
      // advanced state immediately.
      persistContinuationChainState({
        sessionEntry: childEntryForWrite,
        count: advanced.currentChainCount,
        startedAt: advanced.chainStartedAt,
        tokens: advanced.accumulatedChainTokens,
      });
      // Durable write through the session store so the advanced state
      // survives gateway restart and is observable by other readers of
      // the on-disk session entry.
      try {
        const agentId = resolveAgentIdFromSessionKey(params.childSessionKey);
        const storePath = resolveStorePath(cfg.session?.store, { agentId });
        await updateSessionStore(storePath, (store) => {
          const existing = store[params.childSessionKey];
          if (!existing) {
            return;
          }
          store[params.childSessionKey] = {
            ...existing,
            continuationChainCount: advanced.currentChainCount,
            continuationChainStartedAt: advanced.chainStartedAt,
            continuationChainTokens: advanced.accumulatedChainTokens,
          };
        });
      } catch (writeErr) {
        defaultRuntime.error?.(
          `[continuation:drain-persist-failed] child=${params.childSessionKey} error=${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        );
      }
    }
  } catch (err) {
    defaultRuntime.error?.(
      `Subagent continuation delegate drain failed for ${params.childSessionKey}: ${String(err)}`,
    );
  }
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

  const cfg = subagentAnnounceDeps.getRuntimeConfig();
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
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  /** When true, deliver completion as a silent system event instead of a
   *  visible channel message. Used for ambient enrichment (DELEGATE | silent). */
  silentAnnounce?: boolean;
  /** When true (with silentAnnounce), trigger a generation cycle on the parent
   *  session after enrichment delivery. Enables autonomous cognition loops
   *  (DELEGATE | silent-wake). */
  wakeOnReturn?: boolean;
  continuationTargetSessionKey?: string;
  continuationTargetSessionKeys?: string[];
  continuationFanoutMode?: "tree" | "all";
  traceparent?: string;
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

    // F7: drain the child session's continue_delegate queue now that the
    // subagent has settled. Delegates enqueued by the subagent during its
    // turn would otherwise stay orphaned in TaskFlow until the next inbound
    // message on the parent triggers agent-runner dispatch — stalling the
    // two-hop chain. Chain state is inherited from the child session entry
    // so hop labels and cost caps remain accurate across hops.
    // RFC: docs/design/continue-work-signal-v2.md §3.2, §3.4.
    await drainChildContinuationQueue({
      childSessionKey: params.childSessionKey,
      requesterOrigin: targetRequesterOrigin,
    });

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
          // and chain-hop accounting entirely.
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
    const cfg = subagentAnnounceDeps.getRuntimeConfig();
    const continuationEnabled = cfg?.agents?.defaults?.continuation?.enabled === true;

    // Accumulate the completing shard's token cost unconditionally on delegate-return,
    // even if the child doesn't emit another [[CONTINUE_DELEGATE:]]. Without this,
    // children that finish normally leak their tokens from the chain budget.
    const childTask = params.task ?? "";
    const isContinuationChainDelegate = CONTINUATION_CHAIN_HOP_PATTERN.test(childTask);
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
        const chainSignal = continuationResult.signal;
        const chainTask = chainSignal.task;
        const chainDelayMs = chainSignal.delayMs;
        const parentWasSilent = params.silentAnnounce === true;
        const chainSilent = chainSignal.silent || chainSignal.silentWake || parentWasSilent;
        const chainWake =
          chainSignal.silentWake || (parentWasSilent && params.wakeOnReturn === true);

        const { maxChainLength, costCapTokens, minDelayMs, maxDelayMs } =
          subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg);

        const hopMatch = childTask.match(CONTINUATION_CHAIN_HOP_PATTERN);
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

          const doChainSpawn = async (timerTriggered = false) => {
            try {
              const childDepth = getSubagentDepthFromSessionStore(params.childSessionKey);
              const { spawnSubagentDirect } = await loadSubagentSpawnRuntime();
              const spawnResult = await spawnSubagentDirect(
                {
                  task: `[continuation:chain-hop:${nextChainHop}] Delegated from sub-agent (depth ${childDepth}): ${chainTask}`,
                  ...(chainSilent ? { silentAnnounce: true } : {}),
                  ...(chainWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
                  ...(chainSignal.targetSessionKey
                    ? { continuationTargetSessionKey: chainSignal.targetSessionKey }
                    : {}),
                  ...(chainSignal.targetSessionKeys && chainSignal.targetSessionKeys.length > 0
                    ? { continuationTargetSessionKeys: chainSignal.targetSessionKeys }
                    : {}),
                  ...(chainSignal.fanoutMode
                    ? { continuationFanoutMode: chainSignal.fanoutMode }
                    : {}),
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
        } = subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg);
        const hopMatch = childTask.match(CONTINUATION_CHAIN_HOP_PATTERN);
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

          const delegateMode = toolDelegate.mode ?? "normal";
          const toolSilent =
            delegateMode === "silent" || delegateMode === "silent-wake" || parentWasSilent;
          const toolWake =
            delegateMode === "silent-wake" || (parentWasSilent && params.wakeOnReturn === true);
          const toolDelayMs = toolDelegate.delayMs;
          const continuationStateRuntime = await loadContinuationStateRuntime();

          const childDepth = getSubagentDepthFromSessionStore(params.childSessionKey);
          const doToolChainSpawn = async (timerTriggered = false) => {
            try {
              const { spawnSubagentDirect } = await loadSubagentSpawnRuntime();
              const spawnResult = await spawnSubagentDirect(
                {
                  task: `[continuation:chain-hop:${nextToolHop}] Tool-delegated from sub-agent (depth ${childDepth}): ${toolDelegate.task}`,
                  ...(toolSilent ? { silentAnnounce: true } : {}),
                  ...(toolWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
                  ...(toolDelegate.targetSessionKey
                    ? { continuationTargetSessionKey: toolDelegate.targetSessionKey }
                    : {}),
                  ...(toolDelegate.targetSessionKeys && toolDelegate.targetSessionKeys.length > 0
                    ? { continuationTargetSessionKeys: toolDelegate.targetSessionKeys }
                    : {}),
                  ...(toolDelegate.fanoutMode
                    ? { continuationFanoutMode: toolDelegate.fanoutMode }
                    : {}),
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
    const completionTrace = resolveCompletionTraceContext({
      traceparent: params.traceparent,
      task: childTask,
      resolveMaxChainLength: () =>
        subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg).maxChainLength,
    });
    const hasContinuationTargeting = Boolean(
      params.continuationTargetSessionKey ||
      (params.continuationTargetSessionKeys && params.continuationTargetSessionKeys.length > 0) ||
      params.continuationFanoutMode,
    );
    if (hasContinuationTargeting) {
      const { enqueueContinuationReturnDeliveries, resolveContinuationReturnTargetSessionKeys } =
        await import("../auto-reply/continuation/targeting.js");
      const treeSessionKeys =
        params.continuationFanoutMode === "tree" && subagentRegistryRuntime
          ? subagentRegistryRuntime.listAncestorSessionKeys(targetRequesterSessionKey)
          : undefined;
      const allSessionKeys =
        params.continuationFanoutMode === "all" ? await listKnownSessionKeysOnHost(cfg) : undefined;
      const targetSessionKeys = resolveContinuationReturnTargetSessionKeys({
        defaultSessionKey: targetRequesterSessionKey,
        targetSessionKey: params.continuationTargetSessionKey,
        targetSessionKeys: params.continuationTargetSessionKeys,
        fanoutMode: params.continuationFanoutMode,
        treeSessionKeys,
        allSessionKeys,
        childSessionKey: params.childSessionKey,
      });
      const enrichmentText =
        triggerMessage || `[continuation:enrichment-return] Delegate completed: ${taskLabel}`;
      await enqueueContinuationReturnDeliveries({
        targetSessionKeys,
        text: enrichmentText,
        idempotencyKeyBase: `continuation-return:${announceId}`,
        wakeRecipients: params.wakeOnReturn === true || params.silentAnnounce !== true,
        childRunId: params.childRunId,
        ...(params.continuationFanoutMode ? { fanoutMode: params.continuationFanoutMode } : {}),
        ...(completionTrace.chainStepRemaining !== undefined
          ? { chainStepRemaining: completionTrace.chainStepRemaining }
          : {}),
        ...(completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}),
      });
      defaultRuntime.log(
        `[continuation:targeted-return] Delivered to ${targetSessionKeys.join(",")} from ${params.childSessionKey}`,
      );
      didAnnounce = true;
      shouldDeleteChildSession = params.cleanup === "delete";
      return true;
    }

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
    // --- Continuation: silent/wake routing (RFC §2.3) ---
    // If this is a continuation delegate with silentAnnounce, deliver as internal
    // system event instead of channel announce. If wakeOnReturn, also wake parent.
    if (params.silentAnnounce) {
      const { enqueueSystemEvent } = await import("../infra/system-events.js");
      const { createSubsystemLogger } = await import("../logging/subsystem.js");
      const continuationLog = createSubsystemLogger("continuation/announce");

      if (params.wakeOnReturn) {
        continuationLog.info(
          `[continuation/silent-wake] wakeOnReturn=true target=${targetRequesterSessionKey} silentAnnounce=true`,
        );
      }

      // Inject completion as system event (invisible to channel).
      const enrichmentText =
        triggerMessage || `[continuation:enrichment-return] Delegate completed: ${taskLabel}`;
      enqueueSystemEvent(enrichmentText, {
        sessionKey: targetRequesterSessionKey,
        ...(completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}),
      });
      continuationLog.info(
        `[continuation:enrichment-return] Delivered to ${targetRequesterSessionKey} from ${params.childSessionKey}`,
      );

      if (params.wakeOnReturn) {
        const { requestHeartbeatNow } = await import("../infra/heartbeat-wake.js");
        requestHeartbeatNow({
          sessionKey: targetRequesterSessionKey,
          reason: "silent-wake-enrichment",
          parentRunId: params.childRunId,
        });
      }

      didAnnounce = true;
      shouldDeleteChildSession = params.cleanup === "delete";
      return true;
    }

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
      ...(completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}),
    });
    params.onDeliveryResult?.(delivery);
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
      await deleteSubagentSessionForCleanup({
        callGateway: subagentAnnounceDeps.callGateway,
        childSessionKey: params.childSessionKey,
        spawnMode: params.spawnMode,
      });
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
