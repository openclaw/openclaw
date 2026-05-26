import { Hn as ProviderWrapStreamFnContext } from "../../types-Vx7Jq4_-2.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/kimi-coding/stream.d.ts
type KimiThinkingType = "enabled" | "disabled";
type KimiThinkingConfig = {
  type: KimiThinkingType;
  budget_tokens?: number;
};
type KimiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
declare function resolveKimiThinkingConfig(params: {
  configuredThinking: unknown;
  thinkingLevel?: KimiThinkingLevel;
}): KimiThinkingConfig;
declare function resolveKimiThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: KimiThinkingLevel;
}): KimiThinkingType;
declare function createKimiToolCallMarkupWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
declare function createKimiThinkingWrapper(baseStreamFn: StreamFn | undefined, thinkingConfig: KimiThinkingConfig | KimiThinkingType): StreamFn;
declare function wrapKimiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn;
//#endregion
export { createKimiThinkingWrapper, createKimiToolCallMarkupWrapper, resolveKimiThinkingConfig, resolveKimiThinkingType, wrapKimiProviderStream };