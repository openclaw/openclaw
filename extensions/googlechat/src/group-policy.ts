import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "../runtime-api.js";

type GoogleChatGroupContext = {
  cfg: OpenClawConfig;
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
