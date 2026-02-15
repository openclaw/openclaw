import type { ChannelGroupContext } from "openclaw/plugin-sdk";
import { resolveRocketchatAccount } from "./rocketchat/accounts.js";

export function resolveRocketchatGroupRequireMention(
  params: ChannelGroupContext,
): boolean | undefined {
  const account = resolveRocketchatAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (typeof account.requireMention === "boolean") {
    return account.requireMention;
  }
  return true;
}
