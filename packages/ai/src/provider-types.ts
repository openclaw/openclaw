import type * as Llm from "@openclaw/llm-core";
import { PROVIDER_STATE_SCOPE, type ProviderStateScope } from "./session-resources.js";
export type * from "./types.js";

export const PROVIDER_CONTEXT_HANDOFF: unique symbol = Symbol("providerContextHandoff");
export const PROVIDER_MODEL_INPUT: unique symbol = Symbol("providerModelInput");
/** Callable tools deliberately left out of the request's tool list (Tool Search directory). */
export const PROVIDER_DEFERRED_TOOL_NAMES: unique symbol = Symbol("providerDeferredToolNames");
export { PROVIDER_STATE_SCOPE };
/** A completed host interaction whose call belongs only to the provider's history. */
export const NATIVE_HISTORICAL_TOOL_CALL: unique symbol = Symbol("nativeHistoricalToolCall");

export type VideoContent = Omit<Llm.ImageContent, "type"> & { type: "video" };
export type MediaContent = Llm.ImageContent | VideoContent;
export type ModelInputContent = Llm.TextContent | MediaContent;
export type ProviderUserMessage = Omit<Llm.UserMessage, "content"> & {
  content: string | ModelInputContent[];
};
export type ProviderMessage = ProviderUserMessage | Llm.AssistantMessage | Llm.ToolResultMessage;
export type ProviderContext = Omit<Llm.Context, "messages"> & { messages: ProviderMessage[] };
export type ProviderModel<TApi extends Llm.Api = Llm.Api> = Omit<Llm.Model<TApi>, "input"> & {
  input: ModelInputContent["type"][];
};
export type ProviderContextHandoff = () => Promise<ProviderContext>;
export type ProviderStreamOptions = Llm.StreamOptions & {
  [PROVIDER_CONTEXT_HANDOFF]?: ProviderContextHandoff;
  [PROVIDER_MODEL_INPUT]?: ProviderModel["input"];
  [PROVIDER_DEFERRED_TOOL_NAMES]?: ReadonlySet<string>;
  [PROVIDER_STATE_SCOPE]?: ProviderStateScope;
};
export type ProviderStreamFunction<
  TApi extends Llm.Api = Llm.Api,
  TOptions extends Llm.StreamOptions = ProviderStreamOptions,
> = (
  model: ProviderModel<TApi>,
  context: ProviderContext,
  options?: TOptions,
) => Llm.AssistantMessageEventStreamContract;

/** Resolves provider-only context without widening the canonical call contract. */
export async function resolveProviderContext(
  context: Llm.Context | ProviderContext,
  options?: ProviderStreamOptions,
): Promise<ProviderContext> {
  return options?.[PROVIDER_CONTEXT_HANDOFF]?.() ?? context;
}
export type {
  ProviderContext as Context,
  ProviderMessage as Message,
  ProviderModel as Model,
  ProviderStreamFunction as StreamFunction,
};
