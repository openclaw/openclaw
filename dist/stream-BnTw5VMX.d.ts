import { Hn as ProviderWrapStreamFnContext } from "./types-Vx7Jq4_-2.js";
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
declare function wrapCopilotOpenAICompletionsStream(baseStreamFn: StreamFn | undefined): StreamFn | undefined;
declare function wrapCopilotProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
//#endregion
export { wrapCopilotOpenAIResponsesStream as a, wrapCopilotOpenAICompletionsStream as i, hasCopilotVisionInput as n, wrapCopilotProviderStream as o, wrapCopilotAnthropicStream as r, buildCopilotDynamicHeaders as t };