import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { logDebug } from "openclaw/plugin-sdk/logging-core";
import { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import {
  getDiscordEndpointRuntime,
  resolveDiscordEndpointMediaGuard,
  type DiscordEndpointRuntime,
} from "../endpoint-runtime.js";
import type { Client, User } from "../internal/discord.js";
import { resolveDiscordCdnPolicy } from "./media-ssrf-policy.js";

const DISCORD_AVATAR_MAX_BYTES = 256 * 1024;
const DISCORD_AVATAR_CACHE_MAX_ENTRIES = 128;
const DISCORD_GUILD_ICON_TTL_MS = 5 * 60_000;

type GuildIconEntry = {
  expiresAt: number;
  hash: string | null;
};

function setBoundedEntry<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > DISCORD_AVATAR_CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

function discordAvatarUrl(owner: "avatars" | "icons", id: string, hash: string): string {
  return `https://cdn.discordapp.com/${owner}/${id}/${hash}.png?size=128`;
}

/** Dispatcher-lifetime resolver for eventually available Discord conversation images. */
export function createDiscordAvatarResolver() {
  const saved = new Map<string, string>();
  const pending = new Set<string>();
  const guildIcons = new Map<string, GuildIconEntry>();
  const pendingGuilds = new Set<string>();

  const resolveSavedAvatar = (
    key: string,
    url: string,
    endpointRuntime: DiscordEndpointRuntime | null,
  ): string | undefined => {
    const cached = saved.get(key);
    if (cached) {
      saved.delete(key);
      saved.set(key, cached);
      return cached;
    }
    if (pending.has(key) || pending.size >= DISCORD_AVATAR_CACHE_MAX_ENTRIES) {
      return undefined;
    }
    let endpointGuard: ReturnType<typeof resolveDiscordEndpointMediaGuard>;
    try {
      endpointGuard = resolveDiscordEndpointMediaGuard(url, endpointRuntime);
    } catch (error) {
      logDebug(`discord conversation avatar download blocked: ${formatErrorMessage(error)}`);
      return undefined;
    }
    pending.add(key);
    void saveRemoteMedia({
      url,
      filePathHint: "conversation-avatar.png",
      maxBytes: DISCORD_AVATAR_MAX_BYTES,
      ssrfPolicy: endpointGuard?.ssrfPolicy ?? resolveDiscordCdnPolicy(),
      ...(endpointGuard ? { maxRedirects: endpointGuard.maxRedirects } : {}),
    })
      .then((media) => {
        setBoundedEntry(saved, key, media.path);
      })
      .catch((error: unknown) => {
        logDebug(`discord conversation avatar download failed: ${formatErrorMessage(error)}`);
      })
      .finally(() => {
        pending.delete(key);
      });
    return undefined;
  };

  const refreshGuildIcon = (
    client: Client,
    guildId: string,
    conversationId: string,
    endpointRuntime: DiscordEndpointRuntime | null,
  ): void => {
    if (pendingGuilds.has(guildId) || pendingGuilds.size >= DISCORD_AVATAR_CACHE_MAX_ENTRIES) {
      return;
    }
    pendingGuilds.add(guildId);
    void client
      .fetchGuild(guildId)
      .then((guild) => {
        const hash = guild.icon ?? null;
        setBoundedEntry(guildIcons, guildId, {
          expiresAt: Date.now() + DISCORD_GUILD_ICON_TTL_MS,
          hash,
        });
        if (hash) {
          resolveSavedAvatar(
            `${conversationId}\0${hash}`,
            discordAvatarUrl("icons", guildId, hash),
            endpointRuntime,
          );
        }
      })
      .catch((error: unknown) => {
        logDebug(`discord guild icon lookup failed: ${formatErrorMessage(error)}`);
      })
      .finally(() => {
        pendingGuilds.delete(guildId);
      });
  };

  return {
    resolve(params: {
      client: Client;
      conversationId: string;
      author: User;
      guildId?: string;
    }): string | undefined {
      const endpointRuntime = getDiscordEndpointRuntime() ?? null;
      if (!params.guildId) {
        const hash = params.author.avatar;
        return hash
          ? resolveSavedAvatar(
              `${params.conversationId}\0${hash}`,
              discordAvatarUrl("avatars", params.author.id, hash),
              endpointRuntime,
            )
          : undefined;
      }
      const guildIcon = guildIcons.get(params.guildId);
      if (!guildIcon || guildIcon.expiresAt <= Date.now()) {
        refreshGuildIcon(params.client, params.guildId, params.conversationId, endpointRuntime);
      }
      return guildIcon?.hash
        ? resolveSavedAvatar(
            `${params.conversationId}\0${guildIcon.hash}`,
            discordAvatarUrl("icons", params.guildId, guildIcon.hash),
            endpointRuntime,
          )
        : undefined;
    },
  };
}

export type DiscordAvatarResolver = ReturnType<typeof createDiscordAvatarResolver>;
