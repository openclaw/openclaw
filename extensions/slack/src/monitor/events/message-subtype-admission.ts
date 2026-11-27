import type { WebClient } from "@slack/web-api";
import { matchesMentionWithExplicit } from "openclaw/plugin-sdk/channel-inbound";
import {
  collectSlackMentionIds,
  isSlackSubteamMentionForBot,
  normalizeSlackId,
  SLACK_USER_MENTION_RE,
} from "../message-handler/subteam-mentions.js";

export type SlackBotSubtypeAdmission = "allow" | "drop";

/**
 * Applies the `allowBots` policy to a bot-authored message edit or delete.
 *
 * Subtype events bypass the ordinary message pipeline, where `prepareSlackMessage`
 * enforces `allowBots`; callers invoke this only for bot-authored events. A
 * `"mentions"` setting admits only text that addresses the agent the way the
 * ordinary pipeline recognizes: a configured mention pattern, an explicit
 * `<@botUserId>` mention, or a user-group (subteam) mention that includes the
 * bot. DMs always count as addressing the bot.
 */
export async function resolveSlackBotSubtypeAdmission(params: {
  allowBots?: boolean | "mentions";
  botUserId?: string;
  text?: string;
  directMessage?: boolean;
  client?: WebClient;
  teamId?: string;
  mentionRegexes?: RegExp[];
  log?: (message: string) => void;
}): Promise<SlackBotSubtypeAdmission> {
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
  if (
    matchesMentionWithExplicit({
      text: params.text ?? "",
      mentionRegexes: params.mentionRegexes ?? [],
    })
  ) {
    return "allow";
  }
  const botUserId = normalizeSlackId(params.botUserId);
  if (!botUserId) {
    return "drop";
  }
  if (collectSlackMentionIds(params.text, SLACK_USER_MENTION_RE).includes(botUserId)) {
    return "allow";
  }
  if (
    params.client &&
    (await isSlackSubteamMentionForBot({
      client: params.client,
      text: params.text,
      botUserId,
      teamId: params.teamId,
      log: params.log,
    }))
  ) {
    return "allow";
  }
  return "drop";
}
