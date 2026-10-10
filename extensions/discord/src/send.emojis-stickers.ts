import { Routes, type RESTGetAPIGuildEmojisResult } from "discord-api-types/v10";
import { buildOutboundMediaLoadOptions } from "openclaw/plugin-sdk/media-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { listGuildEmojis } from "./internal/discord.js";
import { normalizeEmojiName, resolveDiscordRest } from "./send.shared.js";
import type {
  DiscordAssetUploadOpts,
  DiscordEmojiUpload,
  DiscordOutboundMediaOpts,
  DiscordReactOpts,
  DiscordStickerUpload,
} from "./send.types.js";
import { DISCORD_MAX_EMOJI_BYTES, DISCORD_MAX_STICKER_BYTES } from "./send.types.js";

export const DISCORD_IMAGE_UPLOAD_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
] as const;

export async function loadDiscordMediaForUpload(
  mediaUrl: string,
  opts: DiscordOutboundMediaOpts | undefined,
  maxBytes: number,
  contentTypes: readonly string[],
  invalidType: (contentType: string | undefined) => string,
) {
  // All guild uploads retain the sender-scoped boundary on host-local reads.
  const media = await loadWebMediaRaw(
    mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes,
      mediaAccess: opts?.mediaAccess,
      mediaLocalRoots: opts?.mediaLocalRoots,
      mediaReadFile: opts?.mediaReadFile,
    }),
  );
  const contentType = normalizeOptionalLowercaseString(media.contentType);
  if (!contentType || !contentTypes.includes(contentType)) {
    throw new Error(invalidType(contentType));
  }
  return { media, contentType };
}

export async function listGuildEmojisDiscord(
  guildId: string,
  opts: DiscordReactOpts,
): Promise<RESTGetAPIGuildEmojisResult> {
  const rest = resolveDiscordRest(opts);
  return await listGuildEmojis(rest, guildId);
}

export async function uploadEmojiDiscord(
  payload: DiscordEmojiUpload,
  opts: DiscordAssetUploadOpts,
) {
  const rest = resolveDiscordRest(opts);
  const { media, contentType } = await loadDiscordMediaForUpload(
    payload.mediaUrl,
    opts,
    DISCORD_MAX_EMOJI_BYTES,
    DISCORD_IMAGE_UPLOAD_TYPES,
    () => "Discord emoji uploads require a PNG, JPG, or GIF image",
  );
  const image = `data:${contentType};base64,${media.buffer.toString("base64")}`;
  const roleIds = normalizeStringEntries(payload.roleIds ?? []);
  return await rest.post(Routes.guildEmojis(payload.guildId), {
    body: {
      name: normalizeEmojiName(payload.name, "Emoji name"),
      image,
      roles: roleIds.length ? roleIds : undefined,
    },
  });
}

export async function uploadStickerDiscord(
  payload: DiscordStickerUpload,
  opts: DiscordAssetUploadOpts,
) {
  const rest = resolveDiscordRest(opts);
  const { media, contentType } = await loadDiscordMediaForUpload(
    payload.mediaUrl,
    opts,
    DISCORD_MAX_STICKER_BYTES,
    ["image/png", "image/apng", "application/json"],
    () => "Discord sticker uploads require a PNG, APNG, or Lottie JSON file",
  );
  return await rest.post(Routes.guildStickers(payload.guildId), {
    multipartStyle: "form",
    body: {
      name: normalizeEmojiName(payload.name, "Sticker name"),
      description: normalizeEmojiName(payload.description, "Sticker description"),
      tags: normalizeEmojiName(payload.tags, "Sticker tags"),
      files: [
        {
          data: media.buffer,
          fieldName: "file",
          name: media.fileName ?? "sticker",
          contentType,
        },
      ],
    },
  });
}
