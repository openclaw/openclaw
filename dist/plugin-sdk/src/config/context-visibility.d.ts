import type { OpenClawConfig } from "./config.js";
import type { ContextVisibilityMode } from "./types.base.js";
type ContextVisibilityDefaultsConfig = {
    channels?: {
        defaults?: {
            contextVisibility?: ContextVisibilityMode;
        };
    };
};
export declare function resolveDefaultContextVisibility(cfg: ContextVisibilityDefaultsConfig): ContextVisibilityMode | undefined;
export declare function resolveChannelContextVisibilityMode(params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId?: string | null;
    configuredContextVisibility?: ContextVisibilityMode;
}): ContextVisibilityMode;
export {};
