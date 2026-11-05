import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackMessageEvent } from "../types.js";

type SlackChatType = "direct" | "group" | "channel";

export function inferSlackChannelType(
  channelId?: string | null,
): SlackMessageEvent["channel_type"] | undefined {
  const trimmed = channelId?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("D")) {
    return "im";
  }
  if (trimmed.startsWith("C")) {
    return "channel";
  }
  if (trimmed.startsWith("G")) {
    return "group";
  }
  return undefined;
}

export function parseSlackChannelType(
  channelType?: string | null,
): SlackMessageEvent["channel_type"] | undefined {
  const normalized = normalizeOptionalLowercaseString(channelType);
  if (
    normalized === "im" ||
    normalized === "mpim" ||
    normalized === "channel" ||
    normalized === "group"
  ) {
    return normalized;
  }
  return undefined;
}

export function normalizeSlackChannelType(
  channelType?: string | null,
  channelId?: string | null,
): SlackMessageEvent["channel_type"] {
  const normalized = parseSlackChannelType(channelType);
  const inferred = inferSlackChannelType(channelId);
  // D-prefix channel IDs are always DMs — override a contradicting channel_type.
  if (normalized && inferred !== "im") {
    return normalized;
  }
  return inferred ?? "channel";
}

export function resolveSlackChatType(
  channelType: SlackMessageEvent["channel_type"],
): SlackChatType {
  if (channelType === "im") {
    return "direct";
  }
  if (channelType === "mpim") {
    return "group";
  }
  return "channel";
}
