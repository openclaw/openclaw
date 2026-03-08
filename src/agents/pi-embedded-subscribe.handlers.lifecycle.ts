import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { formatAssistantErrorText } from "./pi-embedded-helpers.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { isAssistantMessage } from "./pi-embedded-utils.js";
import { normalizeUsage, type UsageLike } from "./usage.js";

export {
  handleAutoCompactionEnd,
  handleAutoCompactionStart,
} from "./pi-embedded-subscribe.handlers.compaction.js";

export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.log.debug(`embedded run agent start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt: Date.now(),
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "lifecycle",
    data: { phase: "start" },
  });
}

export function handleAgentEnd(ctx: EmbeddedPiSubscribeContext) {
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";

  // FIX #28632: Detect length-limited responses (output token limit exceeded).
  // When stopReason is "length" or "max_tokens", the response was truncated,
  // not completed normally. Session should not end but continue/retry instead.
  // Cast to string to handle provider variants (e.g. OpenAI "max_tokens") that may
  // arrive before upstream normalization maps them to the canonical "length" value.
  const isLengthLimited =
    isAssistantMessage(lastAssistant) &&
    (lastAssistant.stopReason === "length" ||
      (lastAssistant.stopReason as string) === "max_tokens");

  if (isError && lastAssistant) {
    const friendlyError = formatAssistantErrorText(lastAssistant, {
      cfg: ctx.params.config,
      sessionKey: ctx.params.sessionKey,
      provider: lastAssistant.provider,
      model: lastAssistant.model,
    });
    const errorText = (friendlyError || lastAssistant.errorMessage || "LLM request failed.").trim();
    ctx.log.warn(
      `embedded run agent end: runId=${ctx.params.runId} isError=true error=${errorText}`,
    );
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        error: errorText,
        endedAt: Date.now(),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: errorText,
      },
    });
  } else if (isLengthLimited && lastAssistant) {
    // FIX #28632: Handle output limit gracefully instead of silently freezing.
    // Log the truncation, emit a truncated phase event, and notify user.
    const rawUsage = (lastAssistant as { usage?: unknown }).usage;
    // Use normalizeUsage to read output tokens across provider field variants
    // (output, outputTokens, output_tokens, completionTokens, completion_tokens).
    const outputTokens = normalizeUsage(
      rawUsage != null && typeof rawUsage === "object" ? (rawUsage as UsageLike) : undefined,
    )?.output;

    ctx.log.warn(
      `embedded run truncated at output limit: runId=${ctx.params.runId} ` +
        `stopReason=${lastAssistant.stopReason} outputTokens=${outputTokens ?? "unknown"}`,
    );

    // Emit truncated lifecycle event for observability.
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "truncated",
        stopReason: lastAssistant.stopReason,
        outputTokens,
        message: "Response truncated at output limit. Session continues.",
        endedAt: Date.now(),
      },
    });

    // Route user-facing notice through lifecycle stream so normal onAgentEvent
    // handlers receive it (system stream is not consumed by standard handlers).
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "truncated",
        stopReason: lastAssistant.stopReason,
        message: "Response was truncated due to output limit. Attempting to recover...",
      },
    });

    // Emit terminal end phase so consumers waiting for end/error don't hang.
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        truncated: true,
        endedAt: Date.now(),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: { phase: "end", truncated: true },
    });
  } else {
    ctx.log.debug(`embedded run agent end: runId=${ctx.params.runId} isError=${isError}`);
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: Date.now(),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  }

  ctx.flushBlockReplyBuffer();
  // Flush the reply pipeline so the response reaches the channel before
  // compaction wait blocks the run.  This mirrors the pattern used by
  // handleToolExecutionStart and ensures delivery is not held hostage to
  // long-running compaction (#35074).
  void ctx.params.onBlockReplyFlush?.();

  ctx.state.blockState.thinking = false;
  ctx.state.blockState.final = false;
  ctx.state.blockState.inlineCode = createInlineCodeState();

  if (ctx.state.pendingCompactionRetry > 0) {
    ctx.resolveCompactionRetry();
  } else {
    ctx.maybeResolveCompactionWait();
  }
}
