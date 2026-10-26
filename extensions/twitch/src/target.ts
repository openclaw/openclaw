import { stripChannelTargetPrefix } from "openclaw/plugin-sdk/channel-core";
import { normalizeTwitchChannel } from "./utils/twitch.js";

function parseTwitchMessagingTarget(target: string) {
  const providerTarget = stripChannelTargetPrefix(target, "twitch", "twitch-chat");
  const kindMatch = /^(user|dm|channel|group|conversation|room):/i.exec(providerTarget);
  const kind = kindMatch?.[1]?.toLowerCase();
  return {
    channelTarget: kindMatch ? providerTarget.slice(kindMatch[0].length) : providerTarget,
    isDirectMessage: kind === "user" || kind === "dm",
  };
}

/**
 * Normalizes a Twitch messaging target to the bare channel name used by routing
 * and the chat transport. Accepts internal addresses such as
 * `twitch:channel:<channel>` and their `twitch-chat:` alias. Direct-message
 * targets are unsupported and normalize to an empty string.
 */
export function normalizeTwitchMessagingTarget(target: string): string {
  const parsed = parseTwitchMessagingTarget(target);
  return parsed.isDirectMessage ? "" : normalizeTwitchChannel(parsed.channelTarget);
}

/** Direct-message/user addresses are unsupported and must not fall back to a channel. */
export function isTwitchDirectMessageTarget(target: string): boolean {
  return parseTwitchMessagingTarget(target).isDirectMessage;
}
