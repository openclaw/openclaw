import type { ResolvedMattermostAccount } from "./mattermost/accounts.js";

/**
 * Resolve the trusted per-group `systemPrompt` for a Mattermost channel.
 *
 * Looks up `account.config.groups[<channelId>].systemPrompt` first; if the
 * channel-id key is present at all (even with an empty / whitespace-only
 * value), it suppresses the wildcard — operators can deliberately opt a
 * specific channel out of any prompt by setting it to `""`. Otherwise falls
 * back to `groups["*"].systemPrompt`.
 *
 * Mirrors the established WhatsApp / BlueBubbles convention
 * (`extensions/whatsapp/src/system-prompt.ts`): `specific.systemPrompt != null`
 * suppresses the wildcard, then `trim() || undefined` normalizes the value.
 */
export function resolveMattermostGroupSystemPrompt(params: {
  account: ResolvedMattermostAccount;
  channelId: string;
}): string | undefined {
  const groups = params.account.config.groups;
  if (!groups) {
    return undefined;
  }
  const specific = groups[params.channelId];
  if (specific != null && specific.systemPrompt != null) {
    return specific.systemPrompt.trim() || undefined;
  }
  const wildcard = groups["*"]?.systemPrompt;
  return wildcard != null ? wildcard.trim() || undefined : undefined;
}
