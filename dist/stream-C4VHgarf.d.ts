import { Hn as ProviderWrapStreamFnContext } from "./types-Vx7Jq4_-2.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/vllm/stream.d.ts
type VllmThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
type VllmQwenThinkingFormat = "chat-template" | "top-level";
declare function createVllmQwenThinkingWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  format: VllmQwenThinkingFormat;
  thinkingLevel: VllmThinkingLevel;
}): StreamFn;
declare function createVllmProviderThinkingWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  qwenFormat?: VllmQwenThinkingFormat;
  thinkingLevel: VllmThinkingLevel;
}): StreamFn;
declare function wrapVllmProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
//#endregion
export { createVllmQwenThinkingWrapper as n, wrapVllmProviderStream as r, createVllmProviderThinkingWrapper as t };