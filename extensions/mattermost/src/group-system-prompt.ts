import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { ResolvedMattermostAccount } from "./mattermost/accounts.js";

/**
 * Resolve the trusted per-group `systemPrompt` for a Mattermost channel.
 *
 * Looks up `account.config.groups[<channelId>].systemPrompt` first, then falls
 * back to the wildcard `groups["*"].systemPrompt`. Returns `undefined` when no
 * prompt is configured or the value is empty / whitespace.
 *
 * Mirrors the reference pattern used by IRC, Telegram, Slack, and WhatsApp.
 */
export function resolveMattermostGroupSystemPrompt(params: {
  account: ResolvedMattermostAccount;
  channelId: string;
}): string | undefined {
  const groups = params.account.config.groups;
  if (!groups) {
    return undefined;
  }
  const exact = normalizeOptionalString(groups[params.channelId]?.systemPrompt);
  if (exact) {
    return exact;
  }
  return normalizeOptionalString(groups["*"]?.systemPrompt);
}
