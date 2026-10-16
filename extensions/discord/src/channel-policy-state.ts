import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";

export type DiscordChannelPolicyBinding = {
  guildKey: string;
  channelKey: string;
  channelId: string;
};

const policyBindings = resolveGlobalMap<
  string,
  { channels: readonly DiscordChannelPolicyBinding[]; guilds: ReadonlyMap<string, string> }
>(Symbol.for("openclaw.discord.policy-bindings"), "close-and-restart");

export function setDiscordPolicyBindings(
  accountId: string,
  bindings: readonly DiscordChannelPolicyBinding[],
  guilds: ReadonlyMap<string, string> = new Map(),
): void {
  // Each allowlist resolution replaces the account's complete snapshot, including misses.
  policyBindings.set(normalizeAccountId(accountId), { channels: bindings, guilds });
}

function listBindings(accountId: string | null | undefined, guildKey: string) {
  return (policyBindings.get(normalizeAccountId(accountId))?.channels ?? []).filter(
    (binding) => binding.guildKey === guildKey,
  );
}

export function findDiscordGuildPolicyKey(
  accountId: string | null | undefined,
  guildId: string,
): string | undefined {
  return policyBindings.get(normalizeAccountId(accountId))?.guilds.get(guildId);
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
