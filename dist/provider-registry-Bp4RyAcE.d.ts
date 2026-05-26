import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { C as SpeechProviderId, b as SpeechModelOverridePolicy, x as SpeechProviderConfig, z as TtsDirectiveParseResult } from "./tts-runtime.types-DsGX4LDs.js";
import { Gn as SpeechProviderPlugin } from "./types-Vx7Jq4_-2.js";

//#region src/tts/tts-provider-helpers.d.ts
declare function requireInRange(value: number, min: number, max: number, label: string): void;
declare function normalizeLanguageCode(code?: string): string | undefined;
declare function normalizeApplyTextNormalization(mode?: string): "auto" | "on" | "off" | undefined;
declare function normalizeSeed(seed?: number): number | undefined;
declare function scheduleCleanup(tempDir: string, delayMs?: number): void;
//#endregion
//#region src/tts/directives.d.ts
type ParseTtsDirectiveOptions = {
  cfg?: OpenClawConfig;
  providers?: readonly SpeechProviderPlugin[];
  providerConfigs?: Record<string, SpeechProviderConfig>;
  preferredProviderId?: string;
};
declare function parseTtsDirectives(text: string, policy: SpeechModelOverridePolicy, options?: ParseTtsDirectiveOptions): TtsDirectiveParseResult;
//#endregion
//#region src/tts/provider-registry-core.d.ts
declare function normalizeSpeechProviderId(providerId: string | undefined): SpeechProviderId | undefined;
//#endregion
//#region src/tts/provider-registry.d.ts
declare const listSpeechProviders: (cfg?: OpenClawConfig) => SpeechProviderPlugin[];
declare const listLoadedSpeechProviders: (cfg?: OpenClawConfig) => SpeechProviderPlugin[];
declare const getSpeechProvider: (providerId: string | undefined, cfg?: OpenClawConfig) => SpeechProviderPlugin | undefined;
declare const canonicalizeSpeechProviderId: (providerId: string | undefined, cfg?: OpenClawConfig) => SpeechProviderId | undefined;
//#endregion
export { normalizeSpeechProviderId as a, normalizeLanguageCode as c, scheduleCleanup as d, listSpeechProviders as i, normalizeSeed as l, getSpeechProvider as n, parseTtsDirectives as o, listLoadedSpeechProviders as r, normalizeApplyTextNormalization as s, canonicalizeSpeechProviderId as t, requireInRange as u };