import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import type { RealtimeTranscriptionProviderId } from "./provider-types.js";
export declare function normalizeRealtimeTranscriptionProviderId(providerId: string | undefined): RealtimeTranscriptionProviderId | undefined;
export declare function listRealtimeTranscriptionProviders(cfg?: OpenClawConfig): RealtimeTranscriptionProviderPlugin[];
export declare function getRealtimeTranscriptionProvider(providerId: string | undefined, cfg?: OpenClawConfig): RealtimeTranscriptionProviderPlugin | undefined;
export declare function canonicalizeRealtimeTranscriptionProviderId(providerId: string | undefined, cfg?: OpenClawConfig): RealtimeTranscriptionProviderId | undefined;
