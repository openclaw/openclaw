import { stripSlackMentionsForCommandDetection } from "./commands.js";

/**
 * Phrases that indicate the user is asking the bot to stop responding in the
 * current thread. Matched after Slack mentions are stripped, so "<@U123> mute"
 * and "Monica mute" both reduce to text the patterns below recognize.
 *
 * Kept conservative: bare "stop" is excluded because it appears in normal
 * speech ("let me stop and think"). Re-tagging the bot always clears the mute,
 * so an occasional false positive is recoverable.
 */
const SLACK_MUTE_PATTERNS: readonly RegExp[] = [
  /\bmute\b/i,
  /\bstop responding\b/i,
  /\bstop replying\b/i,
  /\bstop chiming in\b/i,
  /\bbe quiet\b/i,
  /\bstay (?:quiet|silent)\b/i,
  /\bhush\b/i,
  /\bshush\b/i,
];

export type SlackMuteIntent = "mute";

export function detectSlackMuteIntent(text: string): SlackMuteIntent | null {
  const stripped = stripSlackMentionsForCommandDetection(text);
  if (!stripped) {
    return null;
  }
  for (const pattern of SLACK_MUTE_PATTERNS) {
    if (pattern.test(stripped)) {
      return "mute";
    }
  }
  return null;
}
