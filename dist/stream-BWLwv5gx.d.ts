import { Hn as ProviderWrapStreamFnContext } from "./types-Vx7Jq4_-2.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/qwen/stream.d.ts
type QwenThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
type QwenThinkingFormat = string | undefined;
declare function createQwenThinkingWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel: QwenThinkingLevel, thinkingFormat?: QwenThinkingFormat): StreamFn;
declare function wrapQwenProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
//#endregion
export { wrapQwenProviderStream as n, createQwenThinkingWrapper as t };