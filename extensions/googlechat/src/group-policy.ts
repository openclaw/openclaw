import { resolveChannelGroupRequireMention } from "mullusi/plugin-sdk/channel-policy";
import type { MullusiConfig } from "mullusi/plugin-sdk/core";

type GoogleChatGroupContext = {
  cfg: MullusiConfig;
  accountId?: string | null;
  groupId?: string | null;
};

export function resolveGoogleChatGroupRequireMention(params: GoogleChatGroupContext): boolean {
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "googlechat",
    groupId: params.groupId,
    accountId: params.accountId,
  });
}
