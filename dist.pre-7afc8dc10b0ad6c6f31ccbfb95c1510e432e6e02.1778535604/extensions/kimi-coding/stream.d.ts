import { kn as ProviderWrapStreamFnContext } from "../../types-DaukV8xd.js";
import { StreamFn } from "@mariozechner/pi-agent-core";

//#region extensions/kimi-coding/stream.d.ts
type KimiThinkingType = "enabled" | "disabled";
type KimiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
declare function resolveKimiThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: KimiThinkingLevel;
}): KimiThinkingType;
declare function createKimiToolCallMarkupWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
declare function createKimiThinkingWrapper(baseStreamFn: StreamFn | undefined, thinkingType: KimiThinkingType): StreamFn;
declare function wrapKimiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn;
//#endregion
export { createKimiThinkingWrapper, createKimiToolCallMarkupWrapper, resolveKimiThinkingType, wrapKimiProviderStream };