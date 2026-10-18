import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";

export type DiscordChannelPolicyBinding = {
  guildKey: string;
  channelKey: string;
  channelId: string;
};

const channelPolicyBindings = resolveGlobalMap<string, readonly DiscordChannelPolicyBinding[]>(
  Symbol.for("openclaw.discord.channel-policy-bindings"),
  "close-and-restart",
);

export function setDiscordChannelPolicyBindings(
  accountId: string,
  bindings: readonly DiscordChannelPolicyBinding[],
): void {
  // Each allowlist resolution replaces the account's complete snapshot, including misses.
  channelPolicyBindings.set(normalizeAccountId(accountId), [...bindings]);
}

function listBindings(accountId: string | null | undefined, guildKey: string) {
  return (channelPolicyBindings.get(normalizeAccountId(accountId)) ?? []).filter(
    (binding) => binding.guildKey === guildKey,
  );
}

export function getDiscordChannelPolicyBinding(
  accountId: string | null | undefined,
  guildKey: string,
  channelKey: string,
): string | undefined {
  return listBindings(accountId, guildKey).find((binding) => binding.channelKey === channelKey)
    ?.channelId;
}

export function findDiscordChannelPolicyKey(
  accountId: string | null | undefined,
  guildKey: string,
  channelId: string,
): string | undefined {
  return listBindings(accountId, guildKey).find((binding) => binding.channelId === channelId)
    ?.channelKey;
}
