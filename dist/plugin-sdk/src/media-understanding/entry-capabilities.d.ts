import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import type { MediaUnderstandingCapability, MediaUnderstandingCapabilityRegistry } from "./types.js";
export declare function resolveConfiguredMediaEntryCapabilities(entry: MediaUnderstandingModelConfig): MediaUnderstandingCapability[] | undefined;
export declare function resolveEffectiveMediaEntryCapabilities(params: {
    entry: MediaUnderstandingModelConfig;
    source: "shared" | "capability";
    providerRegistry: MediaUnderstandingCapabilityRegistry;
}): MediaUnderstandingCapability[] | undefined;
export declare function matchesMediaEntryCapability(params: {
    entry: MediaUnderstandingModelConfig;
    source: "shared" | "capability";
    capability: MediaUnderstandingCapability;
    providerRegistry: MediaUnderstandingCapabilityRegistry;
}): boolean;
