import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

type DiscordSessionKeyContext = {
  ChatType?: string;
  From?: string;
  SenderId?: string;
};

export function normalizeExplicitDiscordSessionKey(
  sessionKey: string,
  ctx: DiscordSessionKeyContext,
): string {
  let normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  const chatType = normalizeLowercaseStringOrEmpty(ctx.ChatType);
  if (chatType !== "direct" && chatType !== "dm") {
    return normalized;
  }

  normalized = normalized.replace(/^(discord:)dm:/, "$1direct:");
  normalized = normalized.replace(/^(agent:[^:]+:discord:)dm:/, "$1direct:");
  const match = normalized.match(/^((?:agent:[^:]+:)?)discord:channel:([^:]+)$/);
  if (!match) {
    return normalized;
  }

  const from = normalizeLowercaseStringOrEmpty(ctx.From);
  const senderId = normalizeLowercaseStringOrEmpty(ctx.SenderId);
  const fromDiscordId =
    from.startsWith("discord:") && !from.includes(":channel:") && !from.includes(":group:")
      ? from.slice("discord:".length)
      : "";
  const directId = senderId || fromDiscordId;
  return directId && directId === match[2] ? `${match[1]}discord:direct:${match[2]}` : normalized;
}
