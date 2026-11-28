/** The Mail scribe's start dialog choices: how often, whether sent mail is listed, and how far back. */
import { choice, el } from "./page-dom.js";
import {
  defaultOptions,
  MAIL_SCHEDULE,
  type MailSince,
  type ScribeMode,
} from "./scribes-catalog.js";

const MAIL_SINCE: readonly MailSince[] = ["7d", "30d", "today"];

/**
 * "How often", "Which mail" and "Starting from" for the Mail scribe, from `initial` options
 * when given (sent mail included by default).
 */
export function mailFields(changed: () => void, initial = defaultOptions("mail")) {
  const state: { mode: ScribeMode; since: MailSince; sent: boolean } = {
    mode: "ongoing",
    since: initial.since,
    sent: initial.sent,
  };
  const set = (patch: Partial<typeof state>) => () => {
    Object.assign(state, patch);
    changed();
  };
  const often = el("fieldset", undefined, "knowledge-choices");
  often.append(
    el("legend", "How often"),
    choice(
      "radio",
      "scribe-mail-ongoing",
      "Keep learning",
      "Checks for new mail on weekdays at 8 AM, 12 PM and 4 PM.",
      false,
      set({ mode: "ongoing" }),
      true,
      "scribe-mail-often",
    ),
    choice(
      "radio",
      "scribe-mail-once",
      "Once",
      "Works through the mail below, then stops.",
      false,
      set({ mode: "once" }),
      false,
      "scribe-mail-often",
    ),
  );
  const which = el("fieldset", undefined, "knowledge-choices");
  which.append(
    el("legend", "Which mail"),
    el(
      "p",
      "Threads in the Gmail account linked in Composio. Promotions, social and forums mail, mailing lists and automated senders are left out; a decision model, when the agent has one, picks which of the rest are worth remembering.",
      "knowledge-muted",
    ),
    choice(
      "checkbox",
      "scribe-mail-sent",
      "Also threads you wrote in",
      "Lists threads with mail you sent, so your own requests and promises are read, even where nobody has replied yet.",
      false,
      (checked: boolean) => {
        state.sent = checked;
        changed();
      },
      state.sent,
    ),
  );
  const since = el("label", undefined, "knowledge-field");
  const select = el("select", undefined, "scribe-select");
  const labels: Record<MailSince, string> = {
    "7d": "The last 7 days",
    "30d": "The last 30 days",
    today: "Today (new mail only)",
  };
  for (const value of MAIL_SINCE) {
    const option = el("option", labels[value]);
    option.value = value;
    option.selected = value === state.since;
    select.append(option);
  }
  select.addEventListener("change", () => {
    state.since = MAIL_SINCE.find((value) => value === select.value) ?? "7d";
    changed();
  });
  since.append(
    el("span", "Starting from"),
    select,
    el("small", "Threads already in Knowledge are read again only when they get new mail."),
  );
  return {
    nodes: [often, which, since],
    which,
    mode: () => state.mode,
    options: () => ({
      since: state.since,
      sent: state.sent,
      schedule: initial.schedule ?? MAIL_SCHEDULE,
    }),
  };
}
