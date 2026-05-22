import type { OpenClawConfig } from "../config/types.openclaw.js";
export type CodexNativeSearchMode = "cached" | "live";
export type CodexNativeSearchContextSize = "low" | "medium" | "high";
export type CodexNativeSearchUserLocation = {
    country?: string;
    region?: string;
    city?: string;
    timezone?: string;
};
export type ResolvedCodexNativeWebSearchConfig = {
    enabled: boolean;
    mode: CodexNativeSearchMode;
    allowedDomains?: string[];
    contextSize?: CodexNativeSearchContextSize;
    userLocation?: CodexNativeSearchUserLocation;
};
export declare function resolveCodexNativeWebSearchConfig(config: OpenClawConfig | undefined): ResolvedCodexNativeWebSearchConfig;
export declare function describeCodexNativeWebSearch(config: OpenClawConfig | undefined): string | undefined;
