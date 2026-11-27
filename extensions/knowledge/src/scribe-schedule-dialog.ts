/** Change schedule: the dialog that picks a new schedule for a scribe's automation. */
import { button, choice, el } from "./page-dom.js";
import { dialogFrame, scribeTile, show } from "./scribe-dialog.js";
import { SCHEDULE_CHOICES, scheduleWords, type ScribeDefinition } from "./scribes-catalog.js";

/** A cron schedule in a time zone, as Change schedule sets it. */
type CronSchedule = { kind: "cron"; expr: string; tz: string };

/** What Change schedule needs from the page. */
export type ScheduleDialogInput = {
  scribe: ScribeDefinition;
  /** The automation's schedule now. */
  schedule: { kind: string; expr?: string; tz?: string };
  /** A schedule in the page's words. */
  describe: (schedule: CronSchedule) => string;
  /** Asks for the new schedule; a rejection keeps the dialog open with the error. */
  save: (schedule: CronSchedule) => Promise<void>;
};

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6].map((day) =>
  // 2000-01-02 was a Sunday, so day N of the week is January 2 + N.
  new Date(2000, 0, 2 + day).toLocaleDateString(undefined, { weekday: "long" }),
);
const pad = (value: string) => value.padStart(2, "0");

/**
 * Change schedule: the schedules the start dialog offers this scribe, its current one when it
 * is none of them, or a custom one (daily, weekdays or one day a week, at one time), in a time
 * zone. Saving hands the new schedule to the page, which asks the scribe's conversation for it.
 */
export function openScheduleDialog(input: ScheduleDialogInput) {
  const { scribe, schedule } = input;
  const frame = dialogFrame(`Change schedule · ${scribe.title}`, scribeTile(scribe, 28));
  const currentExpr = schedule.kind === "cron" ? schedule.expr?.trim() : undefined;
  const currentTz = schedule.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offered = SCHEDULE_CHOICES[scribe.id] ?? [];
  // A custom schedule starts from the current one when it is one time of day.
  const parsed = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-7])$/.exec(currentExpr ?? "");
  const custom = {
    repeat: !parsed || parsed[3] === "*" ? "daily" : parsed[3] === "1-5" ? "weekdays" : "weekly",
    day: parsed && /^[0-7]$/.test(parsed[3]!) ? Number(parsed[3]) % 7 : 1,
    time: parsed ? `${pad(parsed[2]!)}:${pad(parsed[1]!)}` : "09:00",
  };
  let picked = currentExpr && (offered.includes(currentExpr) || !parsed) ? currentExpr : "custom";
  const expr = () => {
    if (picked !== "custom") {
      return picked;
    }
    const time = /^(\d{2}):(\d{2})$/.exec(custom.time);
    if (!time) {
      return undefined;
    }
    const days =
      custom.repeat === "daily" ? "*" : custom.repeat === "weekdays" ? "1-5" : String(custom.day);
    return `${Number(time[2])} ${Number(time[1])} * * ${days}`;
  };

  const often = el("fieldset", undefined, "knowledge-choices");
  often.append(el("legend", "How often"));
  const pick = (value: string) => () => {
    picked = value;
    refresh();
  };
  const rows: [string, string, string][] = offered.map((value) => {
    const words = scheduleWords(value) ?? value;
    return [
      value,
      `${words[0]!.toUpperCase()}${words.slice(1)}`,
      value === currentExpr ? "Current schedule." : "",
    ];
  });
  if (currentExpr && !offered.includes(currentExpr) && !parsed) {
    rows.unshift([
      currentExpr,
      "Keep the current schedule",
      input.describe({ kind: "cron", expr: currentExpr, tz: currentTz }),
    ]);
  }
  rows.push(["custom", "Custom", "Every day, on weekdays or once a week, at a time you pick."]);
  for (const [value, title, note] of rows) {
    often.append(
      choice(
        "radio",
        `scribe-schedule-${value === "custom" ? "custom" : value.replace(/[^0-9]+/g, "-")}`,
        title,
        note,
        false,
        pick(value),
        value === picked,
        "scribe-schedule",
      ),
    );
  }

  const customFields = el("div", undefined, "scribe-schedule-custom");
  const field = (text: string, control: HTMLElement) => {
    const wrap = el("label", undefined, "knowledge-field");
    wrap.append(el("span", text), control);
    return wrap;
  };
  const repeat = el("select", undefined, "scribe-select");
  for (const [value, text] of [
    ["daily", "Every day"],
    ["weekdays", "Weekdays"],
    ["weekly", "Once a week"],
  ]) {
    const option = el("option", text);
    option.value = value!;
    repeat.append(option);
  }
  repeat.value = custom.repeat;
  repeat.addEventListener("change", () => {
    custom.repeat = repeat.value;
    refresh();
  });
  const day = el("select", undefined, "scribe-select");
  WEEKDAYS.forEach((name, index) => {
    const option = el("option", name);
    option.value = String(index);
    day.append(option);
  });
  day.value = String(custom.day);
  day.addEventListener("change", () => {
    custom.day = Number(day.value);
    refresh();
  });
  const time = el("input", undefined, "scribe-select");
  time.type = "time";
  time.value = custom.time;
  time.addEventListener("input", () => {
    custom.time = time.value;
    refresh();
  });
  const dayField = field("On", day);
  customFields.append(field("Repeat", repeat), dayField, field("At", time));

  // The supported list names regional zones only; UTC and the current zone are added to it.
  const zones = new Set([currentTz, "UTC", ...(Intl.supportedValuesOf?.("timeZone") ?? [])]);
  const tz = el("select", undefined, "scribe-select");
  for (const zone of zones) {
    const option = el("option", zone);
    option.value = zone;
    tz.append(option);
  }
  tz.value = currentTz;
  tz.addEventListener("change", refresh);

  const preview = el("p", "", "scribe-dialog-blurb");
  preview.setAttribute("aria-live", "polite");
  frame.body.append(
    often,
    customFields,
    field("Time zone", tz),
    preview,
    el(
      "p",
      "Later runs follow the new schedule. The run message and other settings stay as they are.",
      "knowledge-muted scribe-dialog-blurb",
    ),
  );

  // One save at a time: editing a field while one is sent must not enable another.
  let saving = false;
  const submit = button(
    "Save schedule",
    () => {
      const next = expr();
      if (!next || saving) {
        return;
      }
      saving = true;
      submit.disabled = true;
      frame.feedback.textContent = "";
      frame.feedback.className = "knowledge-dialog-feedback";
      input.save({ kind: "cron", expr: next, tz: tz.value }).then(
        () => frame.close(),
        (error: unknown) => {
          saving = false;
          refresh();
          frame.feedback.textContent = error instanceof Error ? error.message : String(error);
          frame.feedback.classList.add("knowledge-error");
        },
      );
    },
    "knowledge-button knowledge-primary",
  );
  function refresh() {
    customFields.hidden = picked !== "custom";
    dayField.hidden = custom.repeat !== "weekly";
    const next = expr();
    preview.textContent = next
      ? `New schedule: ${input.describe({ kind: "cron", expr: next, tz: tz.value })}.`
      : "Pick a time.";
    submit.disabled = saving || !next || (next === currentExpr && tz.value === currentTz);
  }
  frame.footer.append(
    button("Cancel", () => frame.close(), "knowledge-quiet"),
    submit,
  );
  refresh();
  show(frame.dialog);
  (frame.dialog.querySelector<HTMLInputElement>("input:checked") ?? submit).focus();
  return frame.dialog;
}
