import {
  buildMessagingTarget,
  type MessagingTarget,
  type MessagingTargetParseOptions,
} from "openclaw/plugin-sdk/messaging-targets";
import { parseMentionPrefixOrAtUserTarget } from "openclaw/plugin-sdk/messaging-targets";

export type SendDiscordTarget = MessagingTarget;

export type SendDiscordTargetParseOptions = MessagingTargetParseOptions;

export function parseDiscordSendTarget(
  raw: string,
  options: SendDiscordTargetParseOptions = {},
): SendDiscordTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const userTarget = parseMentionPrefixOrAtUserTarget({
    raw: trimmed,
    mentionPattern: /^<@!?(\d+)>$/,
    prefixes: [
      { prefix: "user:", kind: "user" },
      { prefix: "channel:", kind: "channel" },
      { prefix: "discord:", kind: "user" },
    ],
    atUserPattern: /^\d+$/,
    atUserErrorMessage: "Discord DMs require a user id (use user:<id> or a <@id> mention)",
  });
  if (userTarget) {
    return userTarget;
  }
  if (/^\d+$/.test(trimmed)) {
    if (options.defaultKind) {
      return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
    }
    throw new Error(
      options.ambiguousMessage ??
        `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
    );
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}
