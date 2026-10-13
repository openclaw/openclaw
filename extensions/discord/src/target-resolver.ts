import { buildMessagingTarget, type MessagingTarget } from "openclaw/plugin-sdk/channel-targets";
import type { DirectoryConfigParams } from "openclaw/plugin-sdk/directory-runtime";
import { resolveDiscordAccount, resolveDiscordAccountAllowFrom } from "./accounts.js";
import { rememberDiscordDirectoryUser } from "./directory-cache.js";
import { listDiscordDirectoryPeersLive } from "./directory-live.js";
import { allowFromContainsDiscordUserId } from "./normalize.js";
import { parseDiscordTarget, type DiscordTargetParseOptions } from "./target-parsing.js";

/**
 * Resolve a Discord username to user ID using the directory lookup.
 * This enables sending DMs by username instead of requiring explicit user IDs.
 */
export async function resolveDiscordTarget(
  raw: string,
  options: DirectoryConfigParams,
  parseOptions: DiscordTargetParseOptions = {},
): Promise<MessagingTarget | undefined> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const likelyUsername = !/^(user:|channel:|discord:|@|<@!?)|[\d]+$/.test(trimmed);
  const shouldLookup =
    /^<@!?(\d+)>$/.test(trimmed) ||
    /^(user:|discord:)/.test(trimmed) ||
    trimmed.startsWith("@") ||
    (/^\d+$/.test(trimmed) && parseOptions.defaultKind === "user") ||
    likelyUsername;

  if (
    /^\d+$/.test(trimmed) &&
    parseOptions.defaultKind !== "user" &&
    allowFromContainsDiscordUserId(resolveDiscordAccountAllowFrom(options) ?? [], trimmed)
  ) {
    return buildMessagingTarget("user", trimmed, trimmed);
  }

  let directParse: MessagingTarget | undefined;
  try {
    directParse = parseDiscordTarget(trimmed, parseOptions);
  } catch {
    // Ambiguous numeric targets can still resolve through the directory.
  }
  if (directParse && directParse.kind !== "channel" && !likelyUsername) {
    return directParse;
  }

  if (!shouldLookup) {
    return directParse ?? parseDiscordTarget(trimmed, parseOptions);
  }

  try {
    const directoryEntries = await listDiscordDirectoryPeersLive({
      ...options,
      query: trimmed,
      limit: 1,
    });

    const match = directoryEntries[0];
    if (match && match.kind === "user") {
      const userId = match.id.replace(/^user:/, "");
      const resolvedAccountId = resolveDiscordAccount(options).accountId;
      rememberDiscordDirectoryUser({
        accountId: resolvedAccountId,
        userId,
        handles: [trimmed, match.name, match.handle],
      });
      return buildMessagingTarget("user", userId, trimmed);
    }
  } catch {
    // Preserve legacy fallback behavior for channel names and direct ids.
  }

  return parseDiscordTarget(trimmed, parseOptions);
}

export async function parseAndResolveDiscordTarget(
  raw: string,
  options: DirectoryConfigParams,
  parseOptions: DiscordTargetParseOptions = {},
): Promise<MessagingTarget> {
  const resolved = await resolveDiscordTarget(raw, options, parseOptions);
  if (!resolved) {
    throw new Error("Recipient is required for Discord sends");
  }
  return resolved;
}
