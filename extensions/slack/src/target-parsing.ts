// Slack plugin module implements target parsing behavior.
import {
  buildMessagingTarget,
  ensureTargetId,
  parseMentionPrefixOrAtUserTarget,
  requireTargetKind,
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
} from "openclaw/plugin-sdk/channel-targets";

export type SlackTargetKind = MessagingTargetKind;

export type SlackTarget = MessagingTarget;

export type SlackTargetParseOptions = MessagingTargetParseOptions;

export function parseSlackTarget(
  raw: string,
  options: SlackTargetParseOptions = {},
): SlackTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const userTarget = parseMentionPrefixOrAtUserTarget({
    raw: trimmed,
    mentionPattern: /^<@([A-Z0-9]+)>$/i,
    prefixes: [
      { prefix: "user:", kind: "user" },
      { prefix: "channel:", kind: "channel" },
      { prefix: "slack:", kind: "user" },
    ],
    atUserPattern: /^[A-Z0-9]+$/i,
    atUserErrorMessage: "Slack DMs require a user id (use user:<id> or <@id>)",
  });
  if (userTarget) {
    return userTarget;
  }
  if (trimmed.startsWith("#")) {
    const candidate = trimmed.slice(1).trim();
    const id = ensureTargetId({
      candidate,
      pattern: /^[A-Z0-9]+$/i,
      errorMessage: "Slack channels require a channel id (use channel:<id>)",
    });
    return buildMessagingTarget("channel", id, trimmed);
  }
  if (options.defaultKind) {
    return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}

export function resolveSlackChannelId(raw: string): string {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  return requireTargetKind({ platform: "Slack", target, kind: "channel" });
}

export function normalizeSlackMessagingTarget(raw: string): string | undefined {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  if (!target) {
    return undefined;
  }
  // Use target.id (case-preserved) instead of target.normalized (lowered).
  // Slack channel IDs are case-sensitive; the lowered form would break API calls
  // when the normalized form is used as a channel identifier downstream.
  return `${target.kind}:${target.id}`;
}

export function slackTargetsMatch(left: string, right: string): boolean {
  const leftTarget = normalizeSlackMessagingTarget(left);
  const rightTarget = normalizeSlackMessagingTarget(right);
  // normalizeSlackMessagingTarget preserves the original case of target IDs;
  // compare case-insensitively for matching purposes.
  return Boolean(
    leftTarget && rightTarget && leftTarget.toLowerCase() === rightTarget.toLowerCase(),
  );
}

export function looksLikeSlackTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^<@([A-Z0-9]+)>$/i.test(trimmed)) {
    return true;
  }
  if (/^(user|channel):/i.test(trimmed)) {
    return true;
  }
  if (/^slack:/i.test(trimmed)) {
    return true;
  }
  if (/^[@#]/.test(trimmed)) {
    return true;
  }
  return /^[CUWGD][A-Z0-9]{8,}$/i.test(trimmed);
}
