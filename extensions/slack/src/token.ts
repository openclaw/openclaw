// Slack plugin module implements token behavior.
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

export type SlackAuthTestIdentity = {
  user_id?: unknown;
  bot_id?: unknown;
};

function readSlackAuthString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function formatSlackBotTokenIdentityWarning(params: {
  auth: SlackAuthTestIdentity;
  accountId?: string | null;
}): string | undefined {
  const userId = readSlackAuthString(params.auth.user_id);
  const botId = readSlackAuthString(params.auth.bot_id);
  if (!userId || botId) {
    return undefined;
  }
  const accountId = readSlackAuthString(params.accountId) ?? "default";
  const tokenPath =
    accountId === "default"
      ? "channels.slack.botToken or SLACK_BOT_TOKEN"
      : `channels.slack.accounts.${accountId}.botToken`;
  return `slack auth.test returned user_id=${userId} without bot_id for account "${accountId}"; ${tokenPath} may contain a Slack user token (xoxp-...) instead of a bot token (xoxb-...). Slack mentions of that user can be mistaken for bot mentions until the token is replaced.`;
}

export function resolveSlackBotToken(
  raw?: unknown,
  path = "channels.slack.botToken",
): string | undefined {
  return normalizeResolvedSecretInputString({ value: raw, path });
}

export function resolveSlackAppToken(
  raw?: unknown,
  path = "channels.slack.appToken",
): string | undefined {
  return normalizeResolvedSecretInputString({ value: raw, path });
}

export function resolveSlackUserToken(
  raw?: unknown,
  path = "channels.slack.userToken",
): string | undefined {
  return normalizeResolvedSecretInputString({ value: raw, path });
}
