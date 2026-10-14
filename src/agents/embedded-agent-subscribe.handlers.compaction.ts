import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { recordSessionCompacted } from "../sessions/session-state-events.js";
import { stripStaleAssistantUsageBeforeLatestCompaction } from "./compaction-usage.js";
import {
  classifyCompactionReason,
  formatUnknownCompactionReasonDetail,
} from "./embedded-agent-runner/compact-reasons.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { AgentSessionEvent } from "./sessions/index.js";

type SessionCompactionStartEvent = Extract<AgentSessionEvent, { type: "compaction_start" }>;
type SessionCompactionEndEvent = Extract<AgentSessionEvent, { type: "compaction_end" }>;

type CompactionStartEvent = Omit<SessionCompactionStartEvent, "reason"> & { reason?: unknown };

function emitCompactionAgentEvent(
  ctx: EmbeddedAgentSubscribeContext,
  data:
    | { phase: "start"; itemId?: string }
    | {
        phase: "end";
        itemId?: string;
        completed: boolean;
        willRetry: boolean;
        outcome: SessionCompactionEndEvent["outcome"]["status"];
        reason?: string;
        qualityDegraded?: true;
      },
): void {
  const event = { stream: "compaction" as const, data };
  emitAgentEvent({ runId: ctx.params.runId, ...event });
  runBestEffortCallback({
    label: "compaction agent event",
    log: ctx.log,
    callback: () => ctx.params.onAgentEvent?.(event),
  });
}

function runBestEffortCompactionHook(
  ctx: EmbeddedAgentSubscribeContext,
  phase: "before" | "after",
): void {
  // Queued events still settle committed facts and waiters after close, not new plugin work.
  if (ctx.state.unsubscribed || ctx.params.isTerminalAborted?.()) {
    return;
  }
  const hookRunner = getGlobalHookRunner();
  const hookName = phase === "before" ? "before_compaction" : "after_compaction";
  if (!hookRunner?.hasHooks(hookName)) {
    return;
  }
  const metrics = {
    messageCount: ctx.params.session.messages?.length ?? 0,
    sessionFile: ctx.params.session.sessionFile,
  };
  const context = { sessionKey: ctx.params.sessionKey };
  const hook =
    phase === "before"
      ? hookRunner.runBeforeCompaction(
          { ...metrics, messages: ctx.params.session.messages },
          context,
        )
      : hookRunner.runAfterCompaction(
          { ...metrics, compactedCount: ctx.getCompactionCount() },
          context,
        );
  void hook.catch((err: unknown) => {
    ctx.log.warn(`${hookName} hook failed: ${String(err)}`);
  });
}

export function handleCompactionStart(
  ctx: EmbeddedAgentSubscribeContext,
  evt: CompactionStartEvent,
) {
  // Unknown reasons come from external runtimes or older sessions. Treat them as
  // threshold compaction so logs and event payloads stay on the closed reason set.
  const rawReason = evt.reason;
  const reason =
    rawReason === "manual" || rawReason === "threshold" || rawReason === "overflow"
      ? rawReason
      : "threshold";
  const kind = reason === "manual" ? "manual compaction" : "auto-compaction";
  ctx.state.compactionInFlight = true;
  ctx.state.livenessState = "paused";
  ctx.ensureCompactionPromise();
  ctx.log.info(`embedded run ${kind} start`, {
    event: "embedded_run_compaction_start",
    runId: ctx.params.runId,
    reason,
    consoleMessage: `embedded run ${kind} start: runId=${ctx.params.runId} reason=${reason}`,
  });
  emitCompactionAgentEvent(ctx, { phase: "start", ...(evt.itemId ? { itemId: evt.itemId } : {}) });

  // Hooks are fire-and-forget so compaction state updates and liveness pauses
  // cannot be delayed by plugin work.
  if (!evt.hooksHandled) {
    runBestEffortCompactionHook(ctx, "before");
  }
}

export function handleCompactionEnd(
  ctx: EmbeddedAgentSubscribeContext,
  evt: SessionCompactionEndEvent,
) {
  const reason = evt.reason;
  const kind = reason === "manual" ? "manual compaction" : "auto-compaction";
  const outcome = evt.outcome;
  ctx.state.compactionInFlight = false;
  const completed = outcome.status === "completed";
  const willRetry = completed && outcome.willRetry;
  let recording: Promise<void> | undefined;
  if (completed) {
    ctx.incrementCompactionCount();
    ctx.noteCompactionTokensAfter(outcome.tokensAfter);
    const observedCompactionCount = ctx.getCompactionCount();
    if (ctx.params.sessionPersistence !== "detached") {
      recording = recordSessionCompacted({
        sessionKey: ctx.params.sessionKey,
        operationId: `${ctx.params.runId}:${observedCompactionCount}`,
        agentId: ctx.params.agentId,
        runId: ctx.params.runId,
      });
    }
    ctx.log.info(`embedded run ${kind} complete`, {
      event: "embedded_run_compaction_end",
      runId: ctx.params.runId,
      reason,
      completed: true,
      willRetry,
      compactionCount: observedCompactionCount,
      consoleMessage: `embedded run ${kind} complete: runId=${ctx.params.runId} reason=${reason} compactionCount=${observedCompactionCount} willRetry=${willRetry}`,
    });
    // Caller-owned turns persist once after settlement; detached runs never write metadata.
    // Keep the legacy floor for direct durable subscriptions without that handoff.
    if (
      ctx.params.compactionCountOwner !== "caller" &&
      ctx.params.sessionPersistence !== "detached"
    ) {
      void import("./embedded-agent-subscribe.handlers.compaction.runtime.js")
        .then(({ default: reconcile }) =>
          reconcile({
            sessionKey: ctx.params.sessionKey,
            agentId: ctx.params.agentId,
            configStore: ctx.params.config?.session?.store,
            observedCompactionCount,
          }),
        )
        .catch((err: unknown) => {
          ctx.log.warn(`late compaction count reconcile failed: ${String(err)}`);
        });
    }
  }
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
    ctx.log.debug(`embedded run compaction retry: runId=${ctx.params.runId}`);
  } else {
    if (outcome.status !== "aborted") {
      ctx.state.livenessState = "working";
    }
    ctx.maybeResolveCompactionWait();
    const messages = ctx.params.session.messages;
    // Only a compaction that actually rewrote history invalidates prior usage.
    // A failed/aborted/skipped end must keep live assistant usage intact —
    // zeroing it disables the persistent-error compaction trigger exactly in
    // the degraded sessions that need it.
    if (completed && Array.isArray(messages)) {
      // Marker-free final compaction has no fresh boundary, so stale totals
      // must be cleared before later context counters inspect assistant usage.
      stripStaleAssistantUsageBeforeLatestCompaction(messages, {
        mutate: true,
        whenMissingCompactionSummary: "zeroAssistantUsage",
      });
    }
  }
  const outcomeReason =
    outcome.status === "skipped" || outcome.status === "failed" ? outcome.reason : undefined;
  if (!completed) {
    const reasonClass = outcomeReason ? classifyCompactionReason(outcomeReason) : "aborted";
    const reasonDetail =
      reasonClass === "unknown" ? formatUnknownCompactionReasonDetail(outcomeReason) : undefined;
    const metadata = {
      event: "embedded_run_compaction_end",
      runId: ctx.params.runId,
      reason,
      outcome: outcome.status,
      completed: false,
      willRetry: false,
      reasonClass,
      ...(outcomeReason ? { outcomeReason } : {}),
      ...(reasonDetail ? { reasonDetail } : {}),
      consoleMessage: `embedded run ${kind} ${outcome.status}: runId=${ctx.params.runId} reason=${reasonClass}${reasonDetail ? ` detail=${reasonDetail}` : ""}`,
    };
    const benign =
      outcome.status === "aborted" ||
      (outcome.status === "skipped" &&
        (reasonClass === "no_compactable_entries" ||
          reasonClass === "below_threshold" ||
          reasonClass === "already_compacted"));
    ctx.log[benign ? "info" : "warn"](`embedded run ${kind} ${outcome.status}`, metadata);
  }
  emitCompactionAgentEvent(ctx, {
    phase: "end",
    ...(evt.itemId ? { itemId: evt.itemId } : {}),
    completed,
    willRetry,
    outcome: outcome.status,
    ...(completed && outcome.qualityDegraded ? { qualityDegraded: true } : {}),
    ...(outcomeReason ? { reason: outcomeReason } : {}),
  });

  // after_compaction runs only once the run will not retry, matching the visible
  // post-compaction session state plugin authors observe.
  if (completed && !willRetry && !evt.hooksHandled) {
    runBestEffortCompactionHook(ctx, "after");
  }
  return recording;
}
