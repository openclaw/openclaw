import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import type { MediaUnderstandingConfig, MediaUnderstandingModelConfig, MediaUnderstandingScopeConfig } from "../config/types.tools.js";
import type { MediaUnderstandingCapability } from "./types.js";
export declare function resolveTimeoutMs(seconds: number | undefined, fallbackSeconds: number): number;
export declare function resolvePrompt(capability: MediaUnderstandingCapability, prompt?: string, maxChars?: number): string;
export declare function resolveMaxChars(params: {
    capability: MediaUnderstandingCapability;
    entry: MediaUnderstandingModelConfig;
    cfg: OpenClawConfig;
    config?: MediaUnderstandingConfig;
}): number | undefined;
export declare function resolveMaxBytes(params: {
    capability: MediaUnderstandingCapability;
    entry: MediaUnderstandingModelConfig;
    cfg: OpenClawConfig;
    config?: MediaUnderstandingConfig;
}): number;
export declare function resolveCapabilityConfig(cfg: OpenClawConfig, capability: MediaUnderstandingCapability): MediaUnderstandingConfig | undefined;
export declare function resolveScopeDecision(params: {
    scope?: MediaUnderstandingScopeConfig;
    ctx: MsgContext;
}): "allow" | "deny";
export declare function resolveModelEntries(params: {
    cfg: OpenClawConfig;
    capability: MediaUnderstandingCapability;
    config?: MediaUnderstandingConfig;
    providerRegistry: Map<string, {
        capabilities?: MediaUnderstandingCapability[];
    }>;
}): MediaUnderstandingModelConfig[];
export declare function resolveConcurrency(cfg: OpenClawConfig): number;
export declare function resolveEntriesWithActiveFallback(params: {
    cfg: OpenClawConfig;
    capability: MediaUnderstandingCapability;
    config?: MediaUnderstandingConfig;
    providerRegistry: Map<string, {
        capabilities?: MediaUnderstandingCapability[];
    }>;
    activeModel?: {
        provider: string;
        model?: string;
    };
}): MediaUnderstandingModelConfig[];
