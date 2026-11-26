import {
  collectSlackMentionIds,
  normalizeSlackId,
  SLACK_USER_MENTION_RE,
} from "../message-handler/subteam-mentions.js";

export type SlackBotSubtypeAdmission = "allow" | "drop";

/**
 * Applies the `allowBots` policy to a bot-authored message edit or delete.
 *
 * Subtype events bypass the ordinary message pipeline, where `prepareSlackMessage`
 * enforces `allowBots`; callers invoke this only for bot-authored events. A
 * `"mentions"` setting admits only text that carries an explicit `<@botUserId>`
 * mention, except in DMs where the ordinary pipeline also admits bot messages
 * without one. Thread and subteam mentions stay out of scope for edits/deletes.
 */
export function resolveSlackBotSubtypeAdmission(params: {
  allowBots?: boolean | "mentions";
  botUserId?: string;
  text?: string;
  directMessage?: boolean;
}): SlackBotSubtypeAdmission {
  const allowBots = params.allowBots ?? true;
  if (allowBots === false) {
    return "drop";
  }
  if (allowBots !== "mentions") {
    return "allow";
  }
  if (params.directMessage) {
    // Mirrors prepareSlackMessage: a DM always counts as addressing the bot.
    return "allow";
  }
  const botUserId = normalizeSlackId(params.botUserId);
  if (!botUserId) {
    return "drop";
  }
  return collectSlackMentionIds(params.text, SLACK_USER_MENTION_RE).includes(botUserId)
    ? "allow"
    : "drop";
}
