import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { makeZeroUsageSnapshot } from "./usage.js";

function readCompactionReason(evt: { reason?: unknown }): "manual" | "threshold" | "overflow" {
  return evt.reason === "manual" || evt.reason === "threshold" || evt.reason === "overflow"
    ? evt.reason
    : "threshold";
}

function compactionLogKind(reason: "manual" | "threshold" | "overflow"): string {
  return reason === "manual" ? "manual compaction" : "auto-compaction";
}

function logCompactionInfo(
  ctx: EmbeddedPiSubscribeContext,
  message: string,
  meta: Record<string, unknown>,
) {
  if (ctx.log.info) {
    ctx.log.info(message, meta);
    return;
  }
  ctx.log.debug(typeof meta.consoleMessage === "string" ? meta.consoleMessage : message, meta);
}

export function handleCompactionStart(ctx: EmbeddedPiSubscribeContext, evt?: { reason?: unknown }) {
  const reason = readCompactionReason(evt ?? {});
  const kind = compactionLogKind(reason);
  ctx.state.compactionInFlight = true;
  ctx.state.livenessState = "paused";
  ctx.ensureCompactionPromise();
  logCompactionInfo(ctx, `embedded run ${kind} start`, {
    event: "embedded_run_compaction_start",
    runId: ctx.params.runId,
    reason,
    consoleMessage: `embedded run ${kind} start: runId=${ctx.params.runId} reason=${reason}`,
  });
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "start" },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "start" },
  });

  // Run before_compaction plugin hook (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_compaction")) {
    void hookRunner
      .runBeforeCompaction(
        {
          messageCount: ctx.params.session.messages?.length ?? 0,
          messages: ctx.params.session.messages,
          sessionFile: ctx.params.session.sessionFile,
        },
        {
          sessionKey: ctx.params.sessionKey,
        },
      )
      .catch((err) => {
        ctx.log.warn(`before_compaction hook failed: ${String(err)}`);
      });
  }
}

export function handleCompactionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { reason?: unknown; willRetry?: unknown; result?: unknown; aborted?: unknown },
) {
  const reason = readCompactionReason(evt);
  const kind = compactionLogKind(reason);
  ctx.state.compactionInFlight = false;
  const willRetry = Boolean(evt.willRetry);
  // Increment counter whenever compaction actually produced a result,
  // regardless of willRetry.  Overflow-triggered compaction sets willRetry=true
  // (the framework retries the LLM request), but the compaction itself succeeded
  // and context was trimmed — the counter must reflect that.  (#38905)
  const hasResult = evt.result != null;
  const wasAborted = Boolean(evt.aborted);
  if (hasResult && !wasAborted) {
    ctx.incrementCompactionCount();
    const tokensAfter =
      typeof evt.result === "object" && evt.result
        ? (evt.result as { tokensAfter?: unknown }).tokensAfter
        : undefined;
    ctx.noteCompactionTokensAfter(tokensAfter);
    const observedCompactionCount = ctx.getCompactionCount();
    logCompactionInfo(ctx, `embedded run ${kind} complete`, {
      event: "embedded_run_compaction_end",
      runId: ctx.params.runId,
      reason,
      completed: true,
      willRetry,
      compactionCount: observedCompactionCount,
      consoleMessage: `embedded run ${kind} complete: runId=${ctx.params.runId} reason=${reason} compactionCount=${observedCompactionCount} willRetry=${willRetry}`,
    });
    void reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey: ctx.params.sessionKey,
      agentId: ctx.params.agentId,
      configStore: ctx.params.config?.session?.store,
      observedCompactionCount,
    }).catch((err) => {
      ctx.log.warn(`late compaction count reconcile failed: ${String(err)}`);
    });
  }
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
    ctx.log.debug(`embedded run compaction retry: runId=${ctx.params.runId}`);
  } else {
    if (!wasAborted) {
      ctx.state.livenessState = "working";
    }
    ctx.maybeResolveCompactionWait();
    clearStaleAssistantUsageOnSessionMessages(ctx);
  }
  if (!hasResult || wasAborted) {
    logCompactionInfo(ctx, `embedded run ${kind} incomplete`, {
      event: "embedded_run_compaction_end",
      runId: ctx.params.runId,
      reason,
      completed: false,
      willRetry,
      aborted: wasAborted,
      consoleMessage: `embedded run ${kind} incomplete: runId=${ctx.params.runId} reason=${reason} aborted=${wasAborted} willRetry=${willRetry}`,
    });
  }
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "end", willRetry, completed: hasResult && !wasAborted },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "end", willRetry, completed: hasResult && !wasAborted },
  });

  // Run after_compaction plugin hook (fire-and-forget)
  if (!willRetry) {
    const hookRunnerEnd = getGlobalHookRunner();
    if (hookRunnerEnd?.hasHooks("after_compaction")) {
      void hookRunnerEnd
        .runAfterCompaction(
          {
            messageCount: ctx.params.session.messages?.length ?? 0,
            compactedCount: ctx.getCompactionCount(),
            sessionFile: ctx.params.session.sessionFile,
          },
          { sessionKey: ctx.params.sessionKey },
        )
        .catch((err) => {
          ctx.log.warn(`after_compaction hook failed: ${String(err)}`);
        });
    }
  }
}

export async function reconcileSessionStoreCompactionCountAfterSuccess(params: {
  sessionKey?: string;
  agentId?: string;
  configStore?: string;
  observedCompactionCount: number;
  now?: number;
}): Promise<number | undefined> {
  const { reconcileSessionStoreCompactionCountAfterSuccess: reconcile } =
    await import("./pi-embedded-subscribe.handlers.compaction.runtime.js");
  return reconcile(params);
}

function clearStaleAssistantUsageOnSessionMessages(ctx: EmbeddedPiSubscribeContext): void {
  const messages = ctx.params.session.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const candidate = message as { role?: unknown; usage?: unknown };
    if (candidate.role !== "assistant") {
      continue;
    }
    // pi-coding-agent expects assistant usage to exist when computing context usage.
    // Reset stale snapshots to zeros instead of deleting the field.
    candidate.usage = makeZeroUsageSnapshot();
  }
}
