import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  resolveReactionLevel,
  type ReactionLevel,
  type ResolvedReactionLevel as BaseResolvedReactionLevel,
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
  // Prompt prep calls this from raw config before the active runtime snapshot
  // has resolved channel credentials. When channels.telegram.botToken is a
  // non-env SecretRef, `resolveTelegramAccount` throws an unresolved-SecretRef
  // error (#75433); treat that as the safe minimal default for discovery
  // instead of crashing the embedded reply run. The runtime delivery path
  // uses the resolved snapshot anyway.
  let account: ReturnType<typeof resolveTelegramAccount>;
  try {
    account = resolveTelegramAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });
  } catch (err) {
    if (err instanceof Error && /unresolved SecretRef/i.test(err.message)) {
      return resolveReactionLevel({
        value: undefined,
        defaultLevel: "minimal",
        invalidFallback: "ack",
      });
    }
    throw err;
  }
  return resolveReactionLevel({
    value: account.config.reactionLevel,
    defaultLevel: "minimal",
    invalidFallback: "ack",
  });
}
