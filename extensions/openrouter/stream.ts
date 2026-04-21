import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { OPENROUTER_THINKING_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream-family";
import { wrapStreamObjectEvents } from "../../src/agents/pi-embedded-runner/run/stream-wrapper.js";

function injectOpenRouterRouting(
  baseStreamFn: StreamFn | undefined,
  providerRouting?: Record<string, unknown>,
): StreamFn | undefined {
  if (!providerRouting) {
    return baseStreamFn;
  }
  return (model, context, options) =>
    (
      baseStreamFn ??
      ((nextModel) => {
        throw new Error(
          `OpenRouter routing wrapper requires an underlying streamFn for ${nextModel.id}.`,
        );
      })
    )(
      {
        ...model,
        compat: { ...model.compat, openRouterRouting: providerRouting },
      } as typeof model,
      context,
      options,
    );
}

function normalizeOpenRouterAssistantMessage(
  message: unknown,
  model: { provider: string; id: string },
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const assistant = message as { provider?: unknown; model?: unknown };
  assistant.provider = model.provider;
  assistant.model = model.id;
}

function createOpenRouterAliasStableStream(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const stream = underlying(model, context, options);
    const originalResult = stream.result.bind(stream);
    stream.result = async () => {
      const message = await originalResult();
      normalizeOpenRouterAssistantMessage(message, model);
      return message;
    };
    return wrapStreamObjectEvents(stream, (event) => {
      normalizeOpenRouterAssistantMessage(event.partial, model);
      normalizeOpenRouterAssistantMessage(event.message, model);
      normalizeOpenRouterAssistantMessage(event.error, model);
    });
  };
}

export function wrapOpenRouterProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | null | undefined {
  const providerRouting =
    ctx.extraParams?.provider != null && typeof ctx.extraParams.provider === "object"
      ? (ctx.extraParams.provider as Record<string, unknown>)
      : undefined;
  const routedStreamFn = providerRouting
    ? injectOpenRouterRouting(ctx.streamFn, providerRouting)
    : ctx.streamFn;
  const wrapStreamFn = OPENROUTER_THINKING_STREAM_HOOKS.wrapStreamFn ?? undefined;
  const wrappedStreamFn =
    wrapStreamFn?.({
      ...ctx,
      streamFn: routedStreamFn,
    }) ?? routedStreamFn;
  return createOpenRouterAliasStableStream(wrappedStreamFn);
}
