import type { ChannelGroupContext } from "openclaw/plugin-sdk";
import { resolveZulipAccount } from "./zulip/accounts.js";

/**
 * Resolve whether Zulip streams require an @mention to trigger a response.
 *
 * Priority:
 * 1. Explicit `requireMention` config field (if set)
 * 2. Inverse of `alwaysReply` (default: alwaysReply=true → requireMention=false)
 */
export function resolveZulipGroupRequireMention(params: ChannelGroupContext): boolean | undefined {
  const account = resolveZulipAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (typeof account.config.requireMention === "boolean") {
    return account.config.requireMention;
  }
  return !account.alwaysReply;
}
