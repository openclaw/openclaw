/** A started scribe's Settings in its detail, and Change settings, which changes which sources it reads. */
import type { Page } from "./page-context.js";
import { button, el } from "./page-dom.js";
import {
  conversationFields,
  dialogFrame,
  granolaFields,
  openConfirmDialog,
  scribeTile,
  show,
} from "./scribe-dialog.js";
import { slackFields } from "./scribe-slack-fields.js";
import { needsUpgrade, updateScribe } from "./scribes-actions.js";
import {
  defaultOptions,
  runPrompt,
  scribeSetup,
  settingsSummary,
  type ScribeDefinition,
  type ScribeId,
  type ScribeOptions,
} from "./scribes-catalog.js";
import type { ScribeDetection, ScribeJob, ScribeSnapshot } from "./scribes-state.js";
import { messageDiff } from "./scribes-updates.js";

/** What Change settings needs from the page. */
type SettingsDialogInput = {
  scribe: ScribeDefinition;
  detection: ScribeDetection;
  /** The settings the scribe's run message was generated from. */
  options: ScribeOptions[ScribeId];
  /** Asks for the new settings; a rejection keeps the dialog open with the error. */
  save: (options: ScribeOptions[ScribeId]) => Promise<void>;
};

// The start dialog's "Which…" choices for a scribe with editable settings, from its settings now.
function settingsFields(input: SettingsDialogInput, changed: () => void) {
  const { scribe, detection, options } = input;
  if (scribe.id === "conversations" && "scope" in options) {
    return { valid: () => true, ...conversationFields(detection, changed, options) };
  }
  if (scribe.id === "granola" && "meetings" in options) {
    return { valid: () => true, ...granolaFields(changed, options) };
  }
  if (scribe.id === "slack" && "userToken" in options) {
    return slackFields(detection, changed, options);
  }
  return undefined;
}

/** Open Change settings for a scribe whose settings Knowledge can read and change. */
function openSettingsDialog(input: SettingsDialogInput) {
  const fields = settingsFields(input, () => refresh());
  if (!fields) {
    return undefined;
  }
  const { scribe } = input;
  const frame = dialogFrame(`Change settings for ${scribe.title}`, scribeTile(scribe, 28));
  // The choices as the dialog opens: the settings now, in the form the fields give them.
  const before = JSON.stringify(fields.options());
  // One save at a time: changing a choice while one is sent must not enable another.
  let saving = false;
  const submit = button("Save settings", () => void save(), "knowledge-button knowledge-primary");
  const refresh = () => {
    submit.disabled = saving || !fields.valid() || JSON.stringify(fields.options()) === before;
  };
  const save = async () => {
    if (saving || submit.disabled) {
      return;
    }
    saving = true;
    refresh();
    frame.feedback.textContent = "";
    frame.feedback.className = "knowledge-dialog-feedback";
    try {
      await input.save(fields.options());
      frame.close();
    } catch (error) {
      frame.feedback.textContent = `The settings were not changed. ${error instanceof Error ? error.message : String(error)}`;
      frame.feedback.classList.add("knowledge-error");
    } finally {
      saving = false;
      if (frame.dialog.open) {
        refresh();
      }
    }
  };
  frame.body.append(
    fields.which,
    el(
      "p",
      "Later runs follow the new settings. The schedule, conversation and Recent runs stay as they are, and what was already learned stays in Knowledge.",
      "knowledge-muted scribe-dialog-blurb",
    ),
  );
  frame.footer.append(
    button("Cancel", () => frame.close(), "knowledge-quiet"),
    submit,
  );
  refresh();
  show(frame.dialog);
  (frame.dialog.querySelector<HTMLElement>("input:not(:disabled)") ?? submit).focus();
  return frame.dialog;
}

/**
 * A started scribe's editable settings with Change…, read from its run message. An edited run
 * message names no settings Knowledge can read, so it offers Reset… to the generated one with
 * the default settings instead (a differing one already offers its new run instructions).
 */
export function settingsValue(
  ui: Page,
  snapshot: ScribeSnapshot,
  job: ScribeJob,
  agentId: string,
  detection: ScribeDetection,
) {
  const { scribe, runMessage } = snapshot;
  const host = ui.s.context.host;
  const value = el("span", undefined, "scribe-status");
  const options =
    runMessage?.state === "current" || runMessage?.state === "outdated"
      ? runMessage.options
      : undefined;
  // The run message keeps the automation's schedule and time zone; only the settings change.
  const save = (next: ScribeOptions[ScribeId]) =>
    updateScribe(host, snapshot, job, agentId, {
      runMessage: runPrompt(scribeSetup(scribe.id, "ongoing", next, job.schedule.tz)),
    });
  // A turn-created automation is replaced only through Upgrade, which says what changes; a
  // settings save would replace it without that confirmation.
  if (needsUpgrade(snapshot)) {
    value.append(
      el("span", "Upgrade the automation to change its settings here", "knowledge-muted"),
    );
    return value;
  }
  if (options) {
    value.append(el("span", settingsSummary(options) ?? ""));
    const change = button(
      "Change…",
      () =>
        openSettingsDialog({
          scribe,
          detection,
          options,
          save: async (next) => {
            await save(next);
            ui.announce(`${scribe.title}: settings changed.`);
            void ui.load();
          },
        }),
      "knowledge-quiet knowledge-small",
    );
    change.setAttribute("aria-label", "Change settings");
    change.disabled = !host.connection.canAdmin;
    value.append(change);
    return value;
  }
  value.append(
    el("span", "Run message edited by hand, so its settings can't be read", "knowledge-muted"),
  );
  if (runMessage?.state === "custom") {
    const defaults = defaultOptions(scribe.id);
    const reset = button(
      "Reset…",
      () =>
        openConfirmDialog(
          `Reset the run message for ${scribe.title}?`,
          `Later runs follow the run message Knowledge generates with the default settings (${settingsSummary(defaults)}). These lines change; the edited message is not kept.`,
          "Reset",
          async () => {
            await save(defaults);
            ui.announce(`${scribe.title}: run message reset.`);
            void ui.load();
          },
          messageDiff(
            job.payload?.message ?? "",
            runPrompt(scribeSetup(scribe.id, "ongoing", defaults, job.schedule.tz)),
          ),
        ),
      "knowledge-quiet knowledge-small",
    );
    reset.setAttribute("aria-label", "Reset run message");
    reset.disabled = !host.connection.canAdmin;
    value.append(reset);
  }
  return value;
}
