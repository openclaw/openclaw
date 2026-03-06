import type { OpenClawConfig } from "../config/config.js";
import { type ReactionLevel, type ResolvedReactionLevel as BaseResolvedReactionLevel } from "../utils/reaction-level.js";
export type TelegramReactionLevel = ReactionLevel;
export type ResolvedReactionLevel = BaseResolvedReactionLevel;
/**
 * Resolve the effective reaction level and its implications.
 */
export declare function resolveTelegramReactionLevel(params: {
    cfg: OpenClawConfig;
    accountId?: string;
}): ResolvedReactionLevel;
