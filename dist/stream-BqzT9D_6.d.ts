import { Ln as ProviderWrapStreamFnContext } from "./types-lCXG2pW_.js";
import { Context } from "@earendil-works/pi-ai";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/github-copilot/stream.d.ts
declare function hasCopilotVisionInput(messages: Context["messages"]): boolean;
declare function buildCopilotDynamicHeaders(params: {
  messages: Context["messages"];
  hasImages: boolean;
}): Record<string, string>;
declare function wrapCopilotAnthropicStream(baseStreamFn: StreamFn | undefined): StreamFn | undefined;
declare function wrapCopilotOpenAIResponsesStream(baseStreamFn: StreamFn | undefined): StreamFn | undefined;
declare function wrapCopilotProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
//#endregion
export { wrapCopilotProviderStream as a, wrapCopilotOpenAIResponsesStream as i, hasCopilotVisionInput as n, wrapCopilotAnthropicStream as r, buildCopilotDynamicHeaders as t };