import { stripChannelTargetPrefix } from "openclaw/plugin-sdk/channel-core";
import { normalizeTwitchChannel } from "./utils/twitch.js";

export function normalizeTwitchMessagingTarget(target: string): string {
  const providerTarget = stripChannelTargetPrefix(target, "twitch", "twitch-chat");
  const kindMatch = /^(user|dm|channel|group|conversation|room):/i.exec(providerTarget);
  const kind = kindMatch?.[1]?.toLowerCase();
  if (kind === "user" || kind === "dm") {
    return "";
  }
  const channelTarget = kindMatch ? providerTarget.slice(kindMatch[0].length) : providerTarget;
  return normalizeTwitchChannel(channelTarget);
}
