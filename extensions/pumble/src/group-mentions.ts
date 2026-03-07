import type { ChannelGroupContext } from "openclaw/plugin-sdk";
import { resolvePumbleAccount } from "./pumble/accounts.js";

export function resolvePumbleGroupRequireMention(params: ChannelGroupContext): boolean | undefined {
  const account = resolvePumbleAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (typeof account.requireMention === "boolean") {
    return account.requireMention;
  }
  return true;
}
