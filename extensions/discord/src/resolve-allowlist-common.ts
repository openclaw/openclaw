import type { DiscordGuildSummary } from "./guilds.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import { normalizeDiscordToken } from "./token.js";

export function resolveDiscordAllowlistToken(token: string): string | undefined {
  return normalizeDiscordToken(token, "channels.discord.token");
}

export function filterDiscordGuilds(
  guilds: DiscordGuildSummary[],
  params: { guildId?: string; guildName?: string },
): DiscordGuildSummary[] {
  if (params.guildId) {
    return guilds.filter((guild) => guild.id === params.guildId);
  }
  if (params.guildName) {
    const slug = normalizeDiscordSlug(params.guildName);
    const match = slug ? guilds.find((guild) => guild.slug === slug) : undefined;
    return match ? [match] : [];
  }
  return guilds;
}

export function parseDiscordAllowlistInput(
  raw: string,
  kind: "channel" | "user",
): { id?: string; name?: string; guild?: string; guildId?: string; guildOnly?: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(kind === "channel" ? /^<#(\d+)>$/ : /^<@!?(\d+)>$/);
  if (mention) {
    return { id: mention[1] };
  }
  const prefixed = trimmed.match(
    kind === "channel" ? /^(?:channel:|discord:)?(\d+)$/i : /^(?:user:|discord:)?(\d+)$/i,
  );
  if (prefixed) {
    return { id: prefixed[1] };
  }
  if (kind === "channel") {
    const guildPrefix = trimmed.match(/^(?:guild:|server:)?(\d+)$/i);
    if (guildPrefix) {
      return { guildId: guildPrefix[1], guildOnly: true };
    }
  }
  const split = trimmed.includes("/") ? trimmed.split("/") : trimmed.split("#");
  if (split.length >= 2) {
    const guild = split[0]?.trim();
    const name = split.slice(1).join("#").trim();
    if (kind === "channel" && !name) {
      return guild ? { guild, guildOnly: true } : {};
    }
    if (guild && /^\d+$/.test(guild)) {
      return kind === "channel" && /^\d+$/.test(name)
        ? { guildId: guild, id: name }
        : { guildId: guild, name };
    }
    return { guild, name };
  }
  return kind === "channel"
    ? { guild: trimmed, guildOnly: true }
    : { name: trimmed.replace(/^@/, "") };
}
