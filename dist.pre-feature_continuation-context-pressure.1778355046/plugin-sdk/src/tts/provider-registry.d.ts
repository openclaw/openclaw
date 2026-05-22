import type { OpenClawConfig } from "../config/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
export { normalizeSpeechProviderId } from "./provider-registry-core.js";
export declare const listSpeechProviders: (cfg?: OpenClawConfig) => SpeechProviderPlugin[];
export declare const getSpeechProvider: (providerId: string | undefined, cfg?: OpenClawConfig) => SpeechProviderPlugin | undefined;
export declare const canonicalizeSpeechProviderId: (providerId: string | undefined, cfg?: OpenClawConfig) => import("./provider-types.ts").SpeechProviderId | undefined;
