import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const trustedRequesterGuildAdminActions = new Set<ChannelMessageActionName>([
  "timeout",
  "kick",
  "ban",
  "emoji-upload",
  "sticker-upload",
  "role-add",
  "role-remove",
  "channel-create",
  "channel-edit",
  "channel-delete",
  "channel-move",
  "category-create",
  "category-edit",
  "category-delete",
  "event-create",
]);

const trustedRequesterProviders = new Set(["discord", "discord-voice"]);

export function requiresDiscordTrustedRequesterForAction(action: string): boolean {
  return trustedRequesterGuildAdminActions.has(action as ChannelMessageActionName);
}

export function isDiscordTrustedRequesterSource(
  toolContext:
    | {
        currentChannelProvider?: string | null;
        requesterSourceProvider?: string | null;
      }
    | undefined,
): boolean {
  const provider = normalizeOptionalString(
    toolContext?.requesterSourceProvider ?? toolContext?.currentChannelProvider,
  )?.toLowerCase();
  return provider ? trustedRequesterProviders.has(provider) : false;
}
