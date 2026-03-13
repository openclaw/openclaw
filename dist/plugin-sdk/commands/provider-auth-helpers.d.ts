import type { OpenClawConfig } from "../config/config.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
export declare function resolveProviderMatch(providers: ProviderPlugin[], rawProvider?: string): ProviderPlugin | null;
export declare function pickAuthMethod(provider: ProviderPlugin, rawMethod?: string): ProviderAuthMethod | null;
export declare function mergeConfigPatch<T>(base: T, patch: unknown): T;
export declare function applyDefaultModel(cfg: OpenClawConfig, model: string): OpenClawConfig;
