import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  buildTextObservationFields,
  sanitizeForConsole,
} from "./pi-embedded-error-observation.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { makeZeroUsageSnapshot } from "./usage.js";

export function handleAutoCompactionStart(
  ctx: EmbeddedPiSubscribeContext,
  evt?: AgentEvent & { reason?: unknown },
) {
  ctx.state.compactionInFlight = true;
  ctx.ensureCompactionPromise();
  const reason = typeof evt?.reason === "string" ? evt.reason : "unknown";
  const safeRunId = sanitizeForConsole(ctx.params.runId) ?? "-";
  const safeSessionKey = sanitizeForConsole(ctx.params.sessionKey) ?? "-";
  const safeReason = sanitizeForConsole(reason) ?? "unknown";
  ctx.log.warn("embedded run compaction start", {
    event: "embedded_run_compaction_start",
    tags: ["compaction", "lifecycle", "auto_compaction_start"],
    runId: ctx.params.runId,
    sessionKey: ctx.params.sessionKey,
    reason,
    messageCount: ctx.params.session.messages?.length ?? 0,
    sessionFile: ctx.params.session.sessionFile,
    consoleMessage: `embedded run compaction start: runId=${safeRunId} reason=${safeReason} sessionKey=${safeSessionKey}`,
  });
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "start", reason },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "start", reason },
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

export function handleAutoCompactionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & {
    willRetry?: unknown;
    result?: unknown;
    aborted?: unknown;
    errorMessage?: unknown;
  },
) {
  ctx.state.compactionInFlight = false;
  const willRetry = Boolean(evt.willRetry);
  // Increment counter whenever compaction actually produced a result,
  // regardless of willRetry.  Overflow-triggered compaction sets willRetry=true
  // (the framework retries the LLM request), but the compaction itself succeeded
  // and context was trimmed — the counter must reflect that.  (#38905)
  const hasResult = evt.result != null;
  const wasAborted = Boolean(evt.aborted);
  const completed = hasResult && !wasAborted;
  const errorMessage =
    typeof evt.errorMessage === "string"
      ? sanitizeForConsole(buildTextObservationFields(evt.errorMessage).textPreview)
      : undefined;
  const safeRunId = sanitizeForConsole(ctx.params.runId) ?? "-";
  const safeSessionKey = sanitizeForConsole(ctx.params.sessionKey) ?? "-";
  const errorConsoleSuffix = errorMessage ? ` error=${errorMessage}` : "";
  if (hasResult && !wasAborted) {
    ctx.incrementCompactionCount?.();
  }
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
    ctx.log.warn("embedded run compaction retry", {
      event: "embedded_run_compaction_retry",
      tags: ["compaction", "lifecycle", "auto_compaction_end", "retry"],
      runId: ctx.params.runId,
      sessionKey: ctx.params.sessionKey,
      hasResult,
      completed,
      wasAborted,
      errorMessage,
      consoleMessage: `embedded run compaction retry: runId=${safeRunId} sessionKey=${safeSessionKey} completed=${completed} hasResult=${hasResult} aborted=${wasAborted}${errorConsoleSuffix}`,
    });
  } else {
    ctx.maybeResolveCompactionWait();
    clearStaleAssistantUsageOnSessionMessages(ctx);
    ctx.log.warn("embedded run compaction end", {
      event: "embedded_run_compaction_end",
      tags: ["compaction", "lifecycle", "auto_compaction_end"],
      runId: ctx.params.runId,
      sessionKey: ctx.params.sessionKey,
      hasResult,
      completed,
      wasAborted,
      errorMessage,
      compactionCount: ctx.getCompactionCount(),
      messageCount: ctx.params.session.messages?.length ?? 0,
      consoleMessage: `embedded run compaction end: runId=${safeRunId} sessionKey=${safeSessionKey} completed=${completed} hasResult=${hasResult} aborted=${wasAborted} willRetry=${willRetry}${errorConsoleSuffix}`,
    });
  }
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "end", willRetry, completed, errorMessage },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "end", willRetry, completed, errorMessage },
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
