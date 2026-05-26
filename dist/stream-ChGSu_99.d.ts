import { Ln as ProviderWrapStreamFnContext } from "./types-lCXG2pW_.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/qwen/stream.d.ts
type QwenThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
declare function createQwenThinkingWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel: QwenThinkingLevel): StreamFn;
declare function wrapQwenProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
//#endregion
export { wrapQwenProviderStream as n, createQwenThinkingWrapper as t };