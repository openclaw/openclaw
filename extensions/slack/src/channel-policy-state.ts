import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";

const slackChannelPolicyBindings = resolveGlobalMap<string, Map<string, string>>(
  Symbol.for("openclaw.slack.channel-policy-bindings"),
  "close-and-restart",
);

export function setSlackChannelPolicyBindings(
  accountId: string,
  bindings: ReadonlyMap<string, string>,
): void {
  // Each policy resolution replaces the account snapshot, including failed or empty lookups.
  slackChannelPolicyBindings.set(
    normalizeAccountId(accountId),
    new Map([...bindings].map(([key, id]) => [key, id.toUpperCase()])),
  );
}

export function getSlackChannelPolicyKeys(accountId: string, channelId?: string | null): string[] {
  const id = channelId?.trim().toUpperCase();
  if (!id) {
    return [];
  }
  const bindings = slackChannelPolicyBindings.get(normalizeAccountId(accountId));
  return [...(bindings ?? [])].filter(([, resolvedId]) => resolvedId === id).map(([key]) => key);
}
