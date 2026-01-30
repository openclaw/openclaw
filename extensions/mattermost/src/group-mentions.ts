import type { ChannelGroupContext } from "openclaw/plugin-sdk";

import { resolveMattermostAccount } from "./mattermost/accounts.js";

export function resolveMattermostGroupRequireMention(
  params: ChannelGroupContext,
): boolean | undefined {
  const account = resolveMattermostAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (typeof account.requireMention === "boolean") return account.requireMention;
  return true;
}
