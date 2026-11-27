/** The Slack scribe's start dialog choices: how often, the user token and DMs opt-ins, and how far back. */
import { choice, el } from "./page-dom.js";
import {
  defaultOptions,
  SLACK_SCHEDULE,
  type ScribeMode,
  type SlackSince,
} from "./scribes-catalog.js";
import type { ScribeDetection } from "./scribes-state.js";

const SLACK_SINCE: readonly SlackSince[] = ["7d", "30d", "today"];

/**
 * "How often", "Which conversations" and "Starting from" for the Slack scribe. The user token
 * choice starts from `initial` (off by default), and can't be turned on when the Slack account is
 * known to have no user token.
 */
export function slackFields(
  detection: ScribeDetection,
  changed: () => void,
  initial = defaultOptions("slack"),
) {
  const state: { mode: ScribeMode; since: SlackSince; userToken: boolean; dms: boolean } = {
    mode: "ongoing",
    since: initial.since,
    userToken: initial.userToken,
    dms: initial.dms,
  };
  const set = (patch: Partial<typeof state>) => () => {
    Object.assign(state, patch);
    changed();
  };
  const toggle = (key: "userToken" | "dms") => (checked: boolean) => {
    state[key] = checked;
    changed();
  };
  const often = el("fieldset", undefined, "knowledge-choices");
  often.append(
    el("legend", "How often"),
    choice(
      "radio",
      "scribe-slack-ongoing",
      "Keep learning",
      "Checks for new messages on weekdays at 9:30 AM, 1:30 PM and 5:30 PM.",
      false,
      set({ mode: "ongoing" }),
      true,
      "scribe-slack-often",
    ),
    choice(
      "radio",
      "scribe-slack-once",
      "Once",
      "Works through the channels below, then stops.",
      false,
      set({ mode: "once" }),
      false,
      "scribe-slack-often",
    ),
  );
  const tokens = detection.tokens?.slack;
  // An account without a bot token can only be read as the user, which the owner must turn on.
  const userOnly = tokens?.bot === false && tokens.user !== false;
  const which = el("fieldset", undefined, "knowledge-choices");
  which.append(
    el("legend", "Which conversations"),
    el(
      "p",
      userOnly
        ? "This Slack account has no bot token, so the scribe can only read as you. Turn on the user token to start."
        : "Every channel your Slack bot is a member of.",
      "knowledge-muted",
    ),
    choice(
      "checkbox",
      "scribe-slack-user-token",
      userOnly ? "Read as you with your user token" : "Also channels your user token can access",
      tokens?.user === false
        ? "No Slack user token is configured for the Slack account."
        : "Uses the Slack user token configured for the Slack account, which can read more than the bot.",
      // Without a user token it can't be turned on, but a saved opt-in can still be turned off.
      tokens?.user === false && !state.userToken,
      toggle("userToken"),
      state.userToken,
    ),
    choice(
      "checkbox",
      "scribe-slack-dms",
      "Direct messages and group DMs",
      "Private conversations the token can read. Off by default.",
      false,
      toggle("dms"),
      state.dms,
    ),
  );
  const since = el("label", undefined, "knowledge-field");
  const select = el("select", undefined, "scribe-select");
  const labels: Record<SlackSince, string> = {
    "7d": "The last 7 days",
    "30d": "The last 30 days",
    today: "Today (new messages only)",
  };
  for (const value of SLACK_SINCE) {
    const option = el("option", labels[value]);
    option.value = value;
    select.append(option);
  }
  select.addEventListener("change", () => {
    state.since = SLACK_SINCE.find((value) => value === select.value) ?? "7d";
    changed();
  });
  since.append(
    el("span", "Starting from"),
    select,
    el("small", "Messages already in Knowledge are skipped."),
  );
  return {
    nodes: [often, which, since],
    which,
    mode: () => state.mode,
    valid: () => !userOnly || state.userToken,
    options: () => ({
      since: state.since,
      userToken: state.userToken,
      dms: state.dms,
      schedule: initial.schedule ?? SLACK_SCHEDULE,
    }),
  };
}
