import {
  buildMessagingTarget,
  parseMentionPrefixOrAtUserTarget,
  requireTargetKind,
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
} from "openclaw/plugin-sdk/channel-targets";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export type DiscordTargetKind = MessagingTargetKind;

export type DiscordTarget = MessagingTarget;

export type DiscordTargetParseOptions = MessagingTargetParseOptions;

export function normalizeDiscordSnowflake(value: string | number | bigint): string | null {
  const text = normalizeOptionalStringifiedId(value) ?? "";
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return text;
}

export function normalizeDiscordHandleKey(raw: string): string | null {
  let handle = normalizeOptionalString(raw) ?? "";
  if (!handle) {
    return null;
  }
  if (handle.startsWith("@")) {
    handle = normalizeOptionalString(handle.slice(1)) ?? "";
  }
  if (!handle || /\s/.test(handle)) {
    return null;
  }
  return handle.toLowerCase();
}

export function formatMention(params: {
  userId?: string | number | bigint | null;
  channelId?: string | number | bigint | null;
}): string {
  const userId = params.userId == null ? null : normalizeDiscordSnowflake(params.userId);
  const channelId = params.channelId == null ? null : normalizeDiscordSnowflake(params.channelId);
  const mentions = [userId ? `<@${userId}>` : null, channelId ? `<#${channelId}>` : null].filter(
    (entry): entry is string => Boolean(entry),
  );
  if (mentions.length !== 1) {
    throw new Error("formatMention requires exactly one of userId or channelId");
  }
  return expectDefined(mentions.at(0), "single Discord mention target");
}

export function parseDiscordTarget(
  raw: string,
  options: DiscordTargetParseOptions = {},
): DiscordTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const providerPrefix = /^discord:(channel|user):(.+)$/i.exec(trimmed);
  if (providerPrefix) {
    const kind = providerPrefix[1]?.toLowerCase() as "channel" | "user" | undefined;
    const id = providerPrefix[2]?.trim();
    if (kind && id) {
      return buildMessagingTarget(kind, id, `${kind}:${id}`);
    }
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
        `Ambiguous Discord recipient "${trimmed}". For DMs use "user:${trimmed}" or "<@${trimmed}>"; for channels use "channel:${trimmed}".`,
    );
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}

export function resolveDiscordChannelId(raw: string): string {
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  return requireTargetKind({ platform: "Discord", target, kind: "channel" });
}
