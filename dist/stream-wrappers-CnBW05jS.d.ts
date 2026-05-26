import { Ln as ProviderWrapStreamFnContext } from "./types-lCXG2pW_.js";
import { t as SubsystemLogger } from "./subsystem-BtuMklFU.js";
import { C as stripTrailingAnthropicAssistantPrefillWhenThinking } from "./provider-stream-shared-DIx4tURD.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/anthropic/stream-wrappers.d.ts
type AnthropicServiceTier = "auto" | "standard_only";
declare function resolveAnthropicBetas(extraParams: Record<string, unknown> | undefined, modelId: string): string[] | undefined;
declare function createAnthropicBetaHeadersWrapper(baseStreamFn: StreamFn | undefined, betas: string[]): StreamFn;
declare function createAnthropicFastModeWrapper(baseStreamFn: StreamFn | undefined, enabled: boolean): StreamFn;
declare function createAnthropicServiceTierWrapper(baseStreamFn: StreamFn | undefined, serviceTier: AnthropicServiceTier): StreamFn;
declare function createAnthropicThinkingPrefillWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
declare function resolveAnthropicFastMode(extraParams: Record<string, unknown> | undefined): boolean | undefined;
declare function resolveAnthropicServiceTier(extraParams: Record<string, unknown> | undefined): AnthropicServiceTier | undefined;
declare function wrapAnthropicProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
declare const __testing: {
  log: SubsystemLogger;
  stripTrailingAssistantPrefillWhenThinking: typeof stripTrailingAnthropicAssistantPrefillWhenThinking;
};
//#endregion
export { createAnthropicThinkingPrefillWrapper as a, resolveAnthropicServiceTier as c, createAnthropicServiceTierWrapper as i, wrapAnthropicProviderStream as l, createAnthropicBetaHeadersWrapper as n, resolveAnthropicBetas as o, createAnthropicFastModeWrapper as r, resolveAnthropicFastMode as s, __testing as t };