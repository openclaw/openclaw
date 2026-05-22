import type { OpenClawConfig } from "../config/types.js";
import { parseProviderModelMap, redactLiveApiKey } from "../media-generation/live-test-helpers.js";
export { parseProviderModelMap, redactLiveApiKey };
export declare const DEFAULT_LIVE_MUSIC_MODELS: Record<string, string>;
export declare function parseCsvFilter(raw?: string): Set<string> | null;
export declare function resolveConfiguredLiveMusicModels(cfg: OpenClawConfig): Map<string, string>;
export declare function resolveLiveMusicAuthStore(params: {
    requireProfileKeys: boolean;
    hasLiveKeys: boolean;
}): import("openclaw/plugin-sdk/provider-auth").AuthProfileStore | undefined;
