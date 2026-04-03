import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
  sanitizeForConsole,
} from "./pi-embedded-error-observation.js";
import { classifyFailoverReason, formatAssistantErrorText } from "./pi-embedded-helpers.js";
import {
  consumePendingToolMediaReply,
  hasAssistantVisibleReply,
} from "./pi-embedded-subscribe.handlers.messages.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { isPromiseLike } from "./pi-embedded-subscribe.promise.js";
import { isAssistantMessage } from "./pi-embedded-utils.js";

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

  if (isError && lastAssistant) {
    const friendlyError = formatAssistantErrorText(lastAssistant, {
      cfg: ctx.params.config,
      sessionKey: ctx.params.sessionKey,
      provider: lastAssistant.provider,
      model: lastAssistant.model,
    });
    const rawError = lastAssistant.errorMessage?.trim();
    const failoverReason = classifyFailoverReason(rawError ?? "");
    const errorText = (friendlyError || lastAssistant.errorMessage || "LLM request failed.").trim();
    const observedError = buildApiErrorObservationFields(rawError);
    const safeErrorText =
      buildTextObservationFields(errorText).textPreview ?? "LLM request failed.";
    const safeRunId = sanitizeForConsole(ctx.params.runId) ?? "-";
    const safeModel = sanitizeForConsole(lastAssistant.model) ?? "unknown";
    const safeProvider = sanitizeForConsole(lastAssistant.provider) ?? "unknown";
    const safeRawErrorPreview = sanitizeForConsole(observedError.rawErrorPreview);
    const rawErrorConsoleSuffix = safeRawErrorPreview ? ` rawError=${safeRawErrorPreview}` : "";
    ctx.log.warn("embedded run agent end", {
      event: "embedded_run_agent_end",
      tags: ["error_handling", "lifecycle", "agent_end", "assistant_error"],
      runId: ctx.params.runId,
      isError: true,
      error: safeErrorText,
      failoverReason,
      model: lastAssistant.model,
      provider: lastAssistant.provider,
      ...observedError,
      consoleMessage: `embedded run agent end: runId=${safeRunId} isError=true model=${safeModel} provider=${safeProvider} error=${safeErrorText}${rawErrorConsoleSuffix}`,
    });
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        error: safeErrorText,
        endedAt: Date.now(),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: safeErrorText,
      },
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

  const finalizeAgentEnd = () => {
    ctx.state.blockState.thinking = false;
    ctx.state.blockState.final = false;
    ctx.state.blockState.inlineCode = createInlineCodeState();

    if (ctx.state.pendingCompactionRetry > 0) {
      ctx.resolveCompactionRetry();
    } else {
      ctx.maybeResolveCompactionWait();
    }
  };

  const flushPendingMediaAndChannel = () => {
    if (ctx.params.onBlockReply) {
      const pendingToolMediaReply = consumePendingToolMediaReply(ctx.state);
      if (pendingToolMediaReply && hasAssistantVisibleReply(pendingToolMediaReply)) {
        ctx.emitBlockReply(pendingToolMediaReply);
      }
    }

    const postMediaFlushResult = ctx.flushBlockReplyBuffer();
    if (isPromiseLike<void>(postMediaFlushResult)) {
      return postMediaFlushResult.then(() => {
        const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
        if (isPromiseLike<void>(onBlockReplyFlushResult)) {
          return onBlockReplyFlushResult;
        }
      });
    }

    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult;
    }
  };

  const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer();
  finalizeAgentEnd();
  if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
    return flushBlockReplyBufferResult.then(() => flushPendingMediaAndChannel());
  }

  const flushPendingMediaAndChannelResult = flushPendingMediaAndChannel();
  if (isPromiseLike<void>(flushPendingMediaAndChannelResult)) {
    return flushPendingMediaAndChannelResult;
  }
}
