import { type Api, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import { type AuthProfileStore } from "./auth-profiles.js";
export { ensureAuthProfileStore, resolveAuthProfileOrder } from "./auth-profiles.js";
export declare function getCustomProviderApiKey(cfg: OpenClawConfig | undefined, provider: string): string | undefined;
export declare function resolveAwsSdkEnvVarName(env?: NodeJS.ProcessEnv): string | undefined;
export type ResolvedProviderAuth = {
    apiKey?: string;
    profileId?: string;
    source: string;
    mode: "api-key" | "oauth" | "token" | "aws-sdk";
};
export declare function resolveApiKeyForProvider(params: {
    provider: string;
    cfg?: OpenClawConfig;
    profileId?: string;
    preferredProfile?: string;
    store?: AuthProfileStore;
    agentDir?: string;
}): Promise<ResolvedProviderAuth>;
export type EnvApiKeyResult = {
    apiKey: string;
    source: string;
};
export type ModelAuthMode = "api-key" | "oauth" | "token" | "mixed" | "aws-sdk" | "unknown";
export declare function resolveEnvApiKey(provider: string): EnvApiKeyResult | null;
export declare function resolveModelAuthMode(provider?: string, cfg?: OpenClawConfig, store?: AuthProfileStore): ModelAuthMode | undefined;
export declare function getApiKeyForModel(params: {
    model: Model<Api>;
    cfg?: OpenClawConfig;
    profileId?: string;
    preferredProfile?: string;
    store?: AuthProfileStore;
    agentDir?: string;
}): Promise<ResolvedProviderAuth>;
export declare function requireApiKey(auth: ResolvedProviderAuth, provider: string): string;
