import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceProviderId } from "./provider-types.js";
export declare function normalizeRealtimeVoiceProviderId(providerId: string | undefined): RealtimeVoiceProviderId | undefined;
export declare function listRealtimeVoiceProviders(cfg?: OpenClawConfig): RealtimeVoiceProviderPlugin[];
export declare function getRealtimeVoiceProvider(providerId: string | undefined, cfg?: OpenClawConfig): RealtimeVoiceProviderPlugin | undefined;
export declare function canonicalizeRealtimeVoiceProviderId(providerId: string | undefined, cfg?: OpenClawConfig): RealtimeVoiceProviderId | undefined;
