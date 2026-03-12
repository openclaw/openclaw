import type { OpenClawConfig } from "../config/config.js";
export declare function maybePersistResolvedTelegramTarget(params: {
    cfg: OpenClawConfig;
    rawTarget: string;
    resolvedChatId: string;
    verbose?: boolean;
}): Promise<void>;
