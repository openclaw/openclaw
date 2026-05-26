import { Hn as ProviderWrapStreamFnContext } from "./types-Vx7Jq4_-2.js";
import { t as SubsystemLogger } from "./subsystem-Ce5qcC5n.js";
import { w as stripTrailingAnthropicAssistantPrefillWhenThinking } from "./provider-stream-shared-BeJa0RWE.js";
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
declare const testing: {
  log: SubsystemLogger;
  stripTrailingAssistantPrefillWhenThinking: typeof stripTrailingAnthropicAssistantPrefillWhenThinking;
};
//#endregion
export { resolveAnthropicBetas as a, testing as c, createAnthropicThinkingPrefillWrapper as i, wrapAnthropicProviderStream as l, createAnthropicFastModeWrapper as n, resolveAnthropicFastMode as o, createAnthropicServiceTierWrapper as r, resolveAnthropicServiceTier as s, createAnthropicBetaHeadersWrapper as t };