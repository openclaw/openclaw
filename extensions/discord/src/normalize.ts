import type { ChannelThreadingToolContext } from "openclaw/plugin-sdk/channel-contract";
import { parseDiscordTarget } from "./target-parsing.js";

export function normalizeDiscordMessagingTarget(raw: string): string | undefined {
  // Default bare IDs to channels so routing is stable across tool actions.
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  return target?.normalized;
}

export function matchesDiscordToolContextTarget(params: {
  target: string;
  toolContext: Pick<ChannelThreadingToolContext, "currentChannelId" | "currentMessagingTarget">;
}): boolean {
  const target = normalizeDiscordMessagingTarget(params.target);
  if (!target) {
    return false;
  }
  return [params.toolContext.currentChannelId, params.toolContext.currentMessagingTarget].some(
    (currentTarget) =>
      currentTarget !== undefined && normalizeDiscordMessagingTarget(currentTarget) === target,
  );
}

/**
 * Normalize a Discord outbound target for delivery. Bare numeric IDs are
 * prefixed with "channel:" to avoid the ambiguous-target error in
 * parseDiscordTarget, unless the ID is explicitly configured as an allowed DM
 * sender. All other formats pass through unchanged.
 */
export function normalizeDiscordOutboundTarget(
  to?: string,
  allowFrom?: readonly string[],
): { ok: true; to: string } | { ok: false; error: Error } {
  const trimmed = to?.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: new Error(
        'Discord recipient is required. Use "channel:<id>" for channels or "user:<id>" for DMs.',
      ),
    };
  }
  if (/^\d+$/.test(trimmed)) {
    const kind = allowFromContainsDiscordUserId(allowFrom, trimmed) ? "user" : "channel";
    return { ok: true, to: `${kind}:${trimmed}` };
  }
  return { ok: true, to: trimmed };
}

export function allowFromContainsDiscordUserId(
  allowFrom: readonly string[] | undefined,
  userId: string,
): boolean {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return false;
  }
  return (allowFrom ?? []).map(normalizeAllowFromDiscordUserId).includes(normalizedUserId);
}

function normalizeAllowFromDiscordUserId(entry: string): string | undefined {
  const trimmed = entry.trim().toLowerCase();
  const mentionMatch = /^<@!?(\d+)>$/.exec(trimmed);
  if (mentionMatch) {
    return mentionMatch[1];
  }
  // Accept both current and legacy allowFrom forms for Discord user IDs.
  return /^(?:(?:discord:)?user:|discord:)?(\d+)$/.exec(trimmed)?.[1];
}

export function looksLikeDiscordTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    /^<@!?\d+>$/.test(trimmed) ||
    /^(?:(?:user|channel|discord):\d+|discord:(?:user|channel):\d+)$/i.test(trimmed) ||
    /^\d{6,}$/.test(trimmed)
  );
}
