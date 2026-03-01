import type { ThinkLevel } from "../auto-reply/thinking.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { buildGeneratingMetadata } from "../infra/generating-metadata.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { formatAssistantErrorText } from "./pi-embedded-helpers.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { isAssistantMessage } from "./pi-embedded-utils.js";

export {
  handleAutoCompactionEnd,
  handleAutoCompactionStart,
} from "./pi-embedded-subscribe.handlers.compaction.js";

export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.log.debug(`embedded run agent start: runId=${ctx.params.runId}`);
  const configuredThink = ctx.params.configuredThinkLevel ?? "auto";
  const effectiveThink = ctx.params.thinkLevel as ThinkLevel | undefined;
  const generating =
    ctx.params.emitGeneratingField === false
      ? undefined
      : buildGeneratingMetadata({
          thinkingLevel: ctx.params.thinkLevel as ThinkLevel | undefined,
          reasoningLevel: ctx.params.reasoningMode ?? "off",
          source: ctx.params.generatingSource,
          autoReasoningEnabled: ctx.params.autoReasoningEnabled,
          provider: ctx.params.provider ?? "",
          model: ctx.params.model ?? "",
          selector: ctx.params.generatingSelector,
        });
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt: Date.now(),
      configuredThink,
      effectiveThink,
      servedProvider: ctx.params.provider ?? "",
      servedModel: ctx.params.model ?? "",
      ...(generating ? { generating } : {}),
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "lifecycle",
    data: {
      phase: "start",
      configuredThink,
      effectiveThink,
      servedProvider: ctx.params.provider ?? "",
      servedModel: ctx.params.model ?? "",
      ...(generating ? { generating } : {}),
    },
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
    const errorText = (friendlyError || lastAssistant.errorMessage || "LLM request failed.").trim();
    ctx.log.warn(
      `embedded run agent end: runId=${ctx.params.runId} isError=true error=${errorText}`,
    );
    const errorGenerating =
      ctx.params.emitGeneratingField === false
        ? undefined
        : buildGeneratingMetadata({
            thinkingLevel: ctx.params.thinkLevel as ThinkLevel | undefined,
            reasoningLevel: ctx.params.reasoningMode ?? "off",
            source: ctx.params.generatingSource,
            autoReasoningEnabled: ctx.params.autoReasoningEnabled,
            provider: ctx.params.provider ?? "",
            model: ctx.params.model ?? "",
            selector: ctx.params.generatingSelector,
          });
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        error: errorText,
        endedAt: Date.now(),
        servedProvider: ctx.params.provider ?? "",
        servedModel: ctx.params.model ?? "",
        ...(errorGenerating ? { generating: errorGenerating } : {}),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: errorText,
        servedProvider: ctx.params.provider ?? "",
        servedModel: ctx.params.model ?? "",
        ...(errorGenerating ? { generating: errorGenerating } : {}),
      },
    });
  } else {
    ctx.log.debug(`embedded run agent end: runId=${ctx.params.runId} isError=${isError}`);
    const generating =
      ctx.params.emitGeneratingField === false
        ? undefined
        : buildGeneratingMetadata({
            thinkingLevel: ctx.params.thinkLevel as ThinkLevel | undefined,
            reasoningLevel: ctx.params.reasoningMode ?? "off",
            source: ctx.params.generatingSource,
            autoReasoningEnabled: ctx.params.autoReasoningEnabled,
            provider: ctx.params.provider ?? "",
            model: ctx.params.model ?? "",
            selector: ctx.params.generatingSelector,
          });
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: Date.now(),
        servedProvider: ctx.params.provider ?? "",
        servedModel: ctx.params.model ?? "",
        ...(generating ? { generating } : {}),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "end",
        servedProvider: ctx.params.provider ?? "",
        servedModel: ctx.params.model ?? "",
        ...(generating ? { generating } : {}),
      },
    });
  }

  ctx.flushBlockReplyBuffer();

  ctx.state.blockState.thinking = false;
  ctx.state.blockState.final = false;
  ctx.state.blockState.inlineCode = createInlineCodeState();

  if (ctx.state.pendingCompactionRetry > 0) {
    ctx.resolveCompactionRetry();
  } else {
    ctx.maybeResolveCompactionWait();
  }
}
