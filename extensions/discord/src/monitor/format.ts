import type { User } from "../internal/discord.js";

export function formatDiscordReactionEmoji(emoji: { id?: string | null; name?: string | null }) {
  if (emoji.id && emoji.name) {
    // Custom guild emoji in Discord-renderable form.
    return `<:${emoji.name}:${emoji.id}>`;
  }
  if (emoji.id) {
    // Keep id visible even when name is missing (instead of opaque "emoji").
    return `emoji:${emoji.id}`;
  }
  return emoji.name ?? "emoji";
}

export function formatDiscordUserTag(user: User) {
  const discriminator = (user.discriminator ?? "").trim();
  if (discriminator && discriminator !== "0") {
    return `${user.username}#${discriminator}`;
  }
  return user.username ?? user.id;
}
