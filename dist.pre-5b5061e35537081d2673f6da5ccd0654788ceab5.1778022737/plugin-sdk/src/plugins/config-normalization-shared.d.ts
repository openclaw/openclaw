import type { OpenClawConfig } from "../config/types.openclaw.js";
export type NormalizedPluginsConfig = {
    enabled: boolean;
    allow: string[];
    deny: string[];
    loadPaths: string[];
    slots: {
        memory?: string | null;
        contextEngine?: string | null;
    };
    entries: Record<string, {
        enabled?: boolean;
        hooks?: {
            allowPromptInjection?: boolean;
            allowConversationAccess?: boolean;
        };
        subagent?: {
            allowModelOverride?: boolean;
            allowedModels?: string[];
            hasAllowedModelsConfig?: boolean;
        };
        config?: unknown;
    }>;
};
export type NormalizePluginId = (id: string) => string;
export declare const identityNormalizePluginId: NormalizePluginId;
export declare function normalizePluginsConfigWithResolver(config?: OpenClawConfig["plugins"], normalizePluginId?: NormalizePluginId): NormalizedPluginsConfig;
export declare function hasExplicitPluginConfig(plugins?: OpenClawConfig["plugins"]): boolean;
export declare function isBundledChannelEnabledByChannelConfig(cfg: OpenClawConfig | undefined, pluginId: string): boolean;
