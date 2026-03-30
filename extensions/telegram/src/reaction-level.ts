import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
	type ResolvedReactionLevel as BaseResolvedReactionLevel,
	type ReactionLevel,
	resolveReactionLevel,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveTelegramAccount } from "./accounts.js";

export type TelegramReactionLevel = ReactionLevel;
export type ResolvedReactionLevel = BaseResolvedReactionLevel;

/**
 * Resolve the effective reaction level and its implications.
 */
export function resolveTelegramReactionLevel(params: {
	cfg: OpenClawConfig;
	accountId?: string;
}): ResolvedReactionLevel {
	const account = resolveTelegramAccount({
		cfg: params.cfg,
		accountId: params.accountId,
	});
	return resolveReactionLevel({
		value: account.config.reactionLevel,
		defaultLevel: "minimal",
		invalidFallback: "ack",
	});
}
