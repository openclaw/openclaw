import { t } from "./i18n/index.js";
/** Scribe dialogs: the start dialog with each scribe's options and prompt, and the turn-off confirmation. */
import { button, choice, el } from "./page-dom.js";
import {
  CONVERSATIONS_SCHEDULE,
  defaultOptions,
  GRANOLA_SCHEDULE,
  REVIEW_NIGHTLY_SCHEDULE,
  REVIEW_WEEKLY_SCHEDULE,
  scribeLabel,
  scribeSetup,
  setupPrompt,
  type ConversationScope,
  type ConversationSince,
  type GranolaMeetings,
  type GranolaSince,
  type MemorySource,
  type ReviewSchedule,
  type ScribeDefinition,
  type ScribeId,
  type ScribeMode,
  type ScribeOptions,
  type ScribePlugin,
} from "./scribes-catalog.js";
import { neededPluginState, type PluginReadiness, type ScribeDetection } from "./scribes-state.js";
import { icon } from "./ui-icons.js";

/** What the start dialog needs from the page. */
export type StartDialogInput = {
  scribe: ScribeDefinition;
  agentName: string;
  storeName: string;
  detection: ScribeDetection;
  canWrite: boolean;
  /** The Control UI's base path, for links to the Plugins page. */
  basePath: string;
  /** Starts the scribe with the prompt shown; a rejection keeps the dialog open with the error. */
  start: (prompt: string) => Promise<void>;
};

/** Scribe tile: the catalog icon on its tone's wash. */
export function scribeTile(scribe: ScribeDefinition, size = 36) {
  const tile = el("span", undefined, `knowledge-tile knowledge-tone-${scribe.tone}`);
  tile.style.setProperty("--tile-size", `${size}px`);
  tile.append(icon(scribe.icon, size >= 36 ? 18 : 15));
  return tile;
}

// What a needed plugin's readiness means, in the page's words.
const PLUGIN_STATE: Record<PluginReadiness, string> = {
  missing: "knowledge.scribeDialog.plugin.missing",
  disabled: "knowledge.scribeDialog.plugin.disabled",
  "needs-sign-in": "knowledge.scribeDialog.plugin.needsSignIn",
  ready: "knowledge.scribeDialog.plugin.ready",
};
/** One line for a needed plugin's readiness. */
export const pluginStateText = (plugin: ScribePlugin, readiness: PluginReadiness) =>
  t(PLUGIN_STATE[readiness], { plugin: plugin.name });

// The control that fixes a needed plugin, by readiness; a ready plugin needs none.
const PLUGIN_ACTION: Record<Exclude<PluginReadiness, "ready">, string> = {
  missing: "knowledge.scribeDialog.plugin.install",
  disabled: "knowledge.scribeDialog.plugin.turnOn",
  "needs-sign-in": "knowledge.scribeDialog.plugin.connect",
};

/**
 * Button that opens the plugin's page under Plugins, where it is installed, turned on and signed
 * in to. It leaves the Knowledge page; the Scribes tab reads the new state when it loads again.
 */
export function pluginButton(
  basePath: string,
  plugin: ScribePlugin,
  readiness: Exclude<PluginReadiness, "ready">,
  className = "knowledge-button knowledge-primary knowledge-small",
) {
  const href = `${basePath}/plugins/${plugin.catalogPath}`;
  return button(
    t(PLUGIN_ACTION[readiness], { plugin: plugin.name }),
    () => window.location.assign(href),
    className,
  );
}

// Modal frame shared by both dialogs: head with close, body, feedback line and actions.
function dialogFrame(title: string, lead?: HTMLElement) {
  const dialog = el("dialog", undefined, "knowledge-store-dialog knowledge-surface scribe-dialog");
  // SAFETY: only focus() is called on it, which every focusable HTML or SVG element implements.
  const previousFocus = document.activeElement as HTMLElement | null;
  const heading = el("h3", title);
  heading.id = "knowledge-scribe-dialog-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  const head = el("div", undefined, "knowledge-store-dialog-head");
  const titleLine = el("span", undefined, "scribe-dialog-head");
  if (lead) {
    titleLine.append(lead);
  }
  titleLine.append(heading);
  const closeButton = button("", () => close(), "knowledge-icon-button");
  closeButton.setAttribute("aria-label", t("knowledge.common.close"));
  closeButton.append(icon("x", 14));
  head.append(titleLine, closeButton);
  const body = el("div", undefined, "knowledge-store-dialog-body"),
    feedback = el("p", "", "knowledge-dialog-feedback"),
    footer = el("div", undefined, "knowledge-actions");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  const close = () => {
    dialog.close();
    dialog.remove();
    previousFocus?.focus();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.append(head, body, feedback, footer);
  return { dialog, body, feedback, footer, close };
}

// Open inside the page so its styles apply; the modal top layer handles stacking.
function show(dialog: HTMLDialogElement) {
  (document.querySelector(".knowledge-page") ?? document.body).append(dialog);
  dialog.showModal();
}

const SINCE: readonly ConversationSince[] = ["30d", "90d", "all", "today"];

// "How often", "Which conversations" and "Starting from" for the conversations scribe.
function conversationFields(detection: ScribeDetection, changed: () => void) {
  const state: { mode: ScribeMode; scope: ConversationScope; since: ConversationSince } = {
    mode: "ongoing",
    scope: "active",
    since: "30d",
  };
  const often = el("fieldset", undefined, "knowledge-choices");
  often.append(el("legend", t("knowledge.scribeDialog.howOften")));
  often.append(
    choice(
      "radio",
      "scribe-often-ongoing",
      t("knowledge.scribeDialog.keepLearning"),
      t("knowledge.scribeDialog.conversations.ongoingHint"),
      false,
      () => {
        state.mode = "ongoing";
        changed();
      },
      true,
      "scribe-often",
    ),
    choice(
      "radio",
      "scribe-often-once",
      t("knowledge.scribeDialog.once"),
      t("knowledge.scribeDialog.conversations.onceHint"),
      false,
      () => {
        state.mode = "once";
        changed();
      },
      false,
      "scribe-often",
    ),
  );
  const { activeConversations: active, archivedConversations: archived } = detection;
  const which = el("fieldset", undefined, "knowledge-choices");
  which.append(el("legend", t("knowledge.scribeDialog.conversations.which")));
  which.append(
    choice(
      "radio",
      "scribe-which-active",
      t("knowledge.scribeDialog.conversations.active"),
      active === undefined
        ? t("knowledge.scribeDialog.conversations.activeHint")
        : t(
            active === 1
              ? "knowledge.scribeDialog.conversations.activeCountOne"
              : "knowledge.scribeDialog.conversations.activeCount",
            { count: active.toLocaleString() },
          ),
      false,
      () => {
        state.scope = "active";
        changed();
      },
      true,
      "scribe-which",
    ),
    choice(
      "radio",
      "scribe-which-all",
      t("knowledge.scribeDialog.conversations.all"),
      active === undefined || archived === undefined
        ? t("knowledge.scribeDialog.conversations.allHint")
        : t(
            active + archived === 1
              ? "knowledge.scribeDialog.conversations.allCountOne"
              : "knowledge.scribeDialog.conversations.allCount",
            { count: (active + archived).toLocaleString() },
          ),
      false,
      () => {
        state.scope = "all";
        changed();
      },
      false,
      "scribe-which",
    ),
  );
  const since = el("label", undefined, "knowledge-field");
  const select = el("select", undefined, "scribe-select");
  for (const value of SINCE) {
    const text = t(`knowledge.scribeDialog.conversations.since.${value}`);
    const option = el("option", text);
    option.value = value;
    select.append(option);
  }
  select.addEventListener("change", () => {
    state.since = SINCE.find((value) => value === select.value) ?? "30d";
    changed();
  });
  since.append(
    el("span", t("knowledge.scribeDialog.startingFrom")),
    select,
    el("small", t("knowledge.scribeDialog.conversations.skipped")),
  );
  return {
    nodes: [often, which, since],
    mode: () => state.mode,
    options: () => ({ scope: state.scope, since: state.since, schedule: CONVERSATIONS_SCHEDULE }),
  };
}

const GRANOLA_SINCE: readonly GranolaSince[] = ["7d", "30d", "today"];

// "How often", "Which meetings" and "Starting from" for the Granola scribe.
function granolaFields(changed: () => void) {
  const state: { mode: ScribeMode; meetings: GranolaMeetings; since: GranolaSince } = {
    mode: "ongoing",
    meetings: "mine",
    since: "7d",
  };
  const set = (patch: Partial<typeof state>) => () => {
    Object.assign(state, patch);
    changed();
  };
  const often = el("fieldset", undefined, "knowledge-choices");
  often.append(
    el("legend", t("knowledge.scribeDialog.howOften")),
    choice(
      "radio",
      "scribe-granola-ongoing",
      t("knowledge.scribeDialog.keepLearning"),
      t("knowledge.scribeDialog.granola.ongoingHint"),
      false,
      set({ mode: "ongoing" }),
      true,
      "scribe-granola-often",
    ),
    choice(
      "radio",
      "scribe-granola-once",
      t("knowledge.scribeDialog.once"),
      t("knowledge.scribeDialog.granola.onceHint"),
      false,
      set({ mode: "once" }),
      false,
      "scribe-granola-often",
    ),
  );
  const which = el("fieldset", undefined, "knowledge-choices");
  which.append(
    el("legend", t("knowledge.scribeDialog.granola.which")),
    choice(
      "radio",
      "scribe-granola-mine",
      t("knowledge.scribeDialog.granola.mine"),
      t("knowledge.scribeDialog.granola.mineHint"),
      false,
      set({ meetings: "mine" }),
      true,
      "scribe-granola-which",
    ),
    choice(
      "radio",
      "scribe-granola-all",
      t("knowledge.scribeDialog.granola.all"),
      t("knowledge.scribeDialog.granola.allHint"),
      false,
      set({ meetings: "all" }),
      false,
      "scribe-granola-which",
    ),
  );
  const since = el("label", undefined, "knowledge-field");
  const select = el("select", undefined, "scribe-select");
  for (const value of GRANOLA_SINCE) {
    const option = el("option", t(`knowledge.scribeDialog.granola.since.${value}`));
    option.value = value;
    select.append(option);
  }
  select.addEventListener("change", () => {
    state.since = GRANOLA_SINCE.find((value) => value === select.value) ?? "7d";
    changed();
  });
  since.append(
    el("span", t("knowledge.scribeDialog.startingFrom")),
    select,
    el("small", t("knowledge.scribeDialog.granola.skipped")),
  );
  return {
    nodes: [often, which, since],
    mode: () => state.mode,
    options: () => ({ meetings: state.meetings, since: state.since, schedule: GRANOLA_SCHEDULE }),
  };
}

/**
 * The needed plugin's state above the choices, with the control that fixes it. Undefined when
 * the scribe needs no plugin or its state could not be read.
 */
function pluginNotice(input: StartDialogInput) {
  const { scribe } = input;
  const readiness = neededPluginState(scribe, input.detection);
  if (!scribe.plugin || !readiness) {
    return undefined;
  }
  const state = pluginStateText(scribe.plugin, readiness);
  const notice = el("div", undefined, "knowledge-effect");
  notice.append(
    el(
      "p",
      readiness === "ready"
        ? t("knowledge.scribeDialog.plugin.readyNotice", { state, plugin: scribe.plugin.name })
        : t("knowledge.scribeDialog.plugin.blockedNotice", { state }),
    ),
  );
  if (readiness !== "ready") {
    notice.append(pluginButton(input.basePath, scribe.plugin, readiness));
  }
  return { node: notice, ready: readiness === "ready" };
}

// "How often" for the review scribe: weekly by default, or nightly after maintenance.
function reviewFields(changed: () => void) {
  let schedule: ReviewSchedule = REVIEW_WEEKLY_SCHEDULE;
  const pick = (value: ReviewSchedule) => () => {
    schedule = value;
    changed();
  };
  const often = el("fieldset", undefined, "knowledge-choices");
  often.append(el("legend", t("knowledge.scribeDialog.howOften")));
  often.append(
    choice(
      "radio",
      "scribe-review-weekly",
      t("knowledge.scribeDialog.review.weekly"),
      t("knowledge.scribeDialog.review.weeklyHint"),
      false,
      pick(REVIEW_WEEKLY_SCHEDULE),
      true,
      "scribe-review-often",
    ),
    choice(
      "radio",
      "scribe-review-nightly",
      t("knowledge.scribeDialog.review.nightly"),
      t("knowledge.scribeDialog.review.nightlyHint"),
      false,
      pick(REVIEW_NIGHTLY_SCHEDULE),
      false,
      "scribe-review-often",
    ),
  );
  return { nodes: [often], options: () => ({ schedule }) };
}

// "What to bring in" for the Memory scribe; at least one source is required.
function memoryFields(detection: ScribeDetection, agentName: string, changed: () => void) {
  const sources = new Set<MemorySource>(["memory-md", "daily-notes"]);
  const toggle = (source: MemorySource) => (checked: boolean) => {
    if (checked) {
      sources.add(source);
    } else {
      sources.delete(source);
    }
    changed();
  };
  const file = detection.memoryFile;
  const memoryNote =
    file === null
      ? t("knowledge.scribeDialog.memory.notFound", { agent: agentName })
      : file?.size !== undefined
        ? t("knowledge.scribeDialog.memory.size", {
            size: Math.max(1, Math.round(file.size / 1024)).toLocaleString(),
            agent: agentName,
          })
        : t("knowledge.scribeDialog.memory.hint");
  const picks = el("fieldset", undefined, "knowledge-choices");
  picks.append(el("legend", t("knowledge.scribeDialog.memory.what")));
  picks.append(
    choice(
      "checkbox",
      "scribe-memory-md",
      "MEMORY.md",
      memoryNote,
      false,
      toggle("memory-md"),
      true,
    ),
    choice(
      "checkbox",
      "scribe-memory-daily",
      t("knowledge.scribeDialog.memory.daily"),
      t("knowledge.scribeDialog.memory.dailyHint"),
      false,
      toggle("daily-notes"),
      true,
    ),
    choice(
      "checkbox",
      "scribe-memory-dreams",
      t("knowledge.scribeDialog.memory.dreams"),
      t("knowledge.scribeDialog.memory.dreamsHint"),
      false,
      toggle("dreams"),
    ),
  );
  return {
    nodes: [picks],
    valid: () => sources.size > 0,
    options: () => ({
      sources: (["memory-md", "daily-notes", "dreams"] as const).filter((s) => sources.has(s)),
    }),
  };
}

// What starting does, in the dialog's own words.
function effectText(input: StartDialogInput, mode: ScribeMode) {
  const { scribe, storeName } = input;
  const effect = el("div", undefined, "knowledge-effect");
  const lead = el("p");
  // The session name is set in bold, so the sentence is split at its placeholder.
  const [before, after = ""] = t("knowledge.scribeDialog.effect.lead", { store: storeName }).split(
    "{session}",
  );
  lead.append(
    before!,
    el("strong", scribeLabel(scribe)),
    `${after} `,
    t(
      mode === "once"
        ? scribe.id === "memory"
          ? "knowledge.scribeDialog.effect.onceMemory"
          : "knowledge.scribeDialog.effect.once"
        : scribe.id === "claim-consolidation"
          ? "knowledge.scribeDialog.effect.scheduled"
          : "knowledge.scribeDialog.effect.ongoing",
    ),
  );
  effect.append(
    lead,
    el(
      "p",
      t(
        mode === "once"
          ? "knowledge.scribeDialog.effect.model"
          : "knowledge.scribeDialog.effect.modelOngoing",
        { agent: input.agentName },
      ),
      "knowledge-muted",
    ),
  );
  return effect;
}

/**
 * The editable "Prompt" area: the full message Start sends. It follows the choices until the
 * operator types in it; then it keeps their text until they ask for the generated one again.
 */
function promptField(generate: () => string, changed: () => void) {
  const details = el("details", undefined, "scribe-prompt");
  const text = el("textarea", undefined, "scribe-prompt-text");
  text.rows = 14;
  text.spellcheck = false;
  text.setAttribute("aria-label", t("knowledge.scribeDialog.prompt"));
  const note = el("small");
  let edited = false;
  const sync = () => {
    if (!edited) {
      text.value = generate();
    }
    note.textContent = edited
      ? t("knowledge.scribeDialog.promptEdited")
      : t("knowledge.scribeDialog.promptGenerated");
    reset.hidden = !edited;
  };
  const reset = button(
    t("knowledge.scribeDialog.useGenerated"),
    () => {
      edited = false;
      sync();
      changed();
    },
    "knowledge-quiet knowledge-small",
  );
  text.addEventListener("input", () => {
    if (!edited) {
      edited = true;
      sync();
    }
    changed();
  });
  const foot = el("span", undefined, "scribe-prompt-foot");
  foot.append(note, reset);
  details.append(el("summary", t("knowledge.scribeDialog.prompt")), text, foot);
  return { node: details, sync, value: () => text.value, edited: () => edited };
}

/** Open the start dialog for one scribe. Starting is disabled without write access. */
export function openStartDialog(input: StartDialogInput) {
  const { scribe } = input;
  const frame = dialogFrame(
    t(`knowledge.scribes.catalog.${scribe.id}.dialogTitle`),
    scribeTile(scribe),
  );
  const effectSlot = el("div");
  let mode: () => ScribeMode = () => scribe.modes[0]!;
  let options: () => ScribeOptions[ScribeId] = () => defaultOptions(scribe.id);
  let valid = () => true;
  let pluginReady = true;
  let starting = false;
  const submit = button(
    t(`knowledge.scribes.catalog.${scribe.id}.submit`),
    () => void run(),
    "knowledge-button knowledge-primary",
  );
  // A needed plugin must be ready. A hand-edited prompt then only needs text; a generated one
  // needs valid choices.
  const ready = () => pluginReady && (prompt.edited() ? Boolean(prompt.value().trim()) : valid());
  const refresh = () => {
    submit.disabled = starting || !input.canWrite || !ready();
    submit.textContent = t(
      starting
        ? "knowledge.scribeDialog.starting"
        : `knowledge.scribes.catalog.${scribe.id}.submit`,
    );
    effectSlot.replaceChildren(effectText(input, mode()));
  };
  const prompt = promptField(() => setupPrompt(scribeSetup(scribe.id, mode(), options())), refresh);
  // A changed choice regenerates the prompt unless it was edited by hand.
  const changed = () => {
    prompt.sync();
    refresh();
  };
  frame.body.append(
    el("p", t(`knowledge.scribes.catalog.${scribe.id}.blurb`), "scribe-dialog-blurb"),
  );
  // A needed plugin that is known not to be ready blocks starting; an unknown state does not.
  const notice = pluginNotice(input);
  if (notice) {
    frame.body.append(notice.node);
    pluginReady = notice.ready;
  }
  if (scribe.id === "conversations") {
    const fields = conversationFields(input.detection, changed);
    frame.body.append(...fields.nodes);
    mode = fields.mode;
    options = fields.options;
  } else if (scribe.id === "granola") {
    const fields = granolaFields(changed);
    frame.body.append(...fields.nodes);
    mode = fields.mode;
    options = fields.options;
  } else if (scribe.id === "claim-consolidation") {
    const fields = reviewFields(changed);
    frame.body.append(...fields.nodes);
    options = fields.options;
  } else if (scribe.id === "memory") {
    const fields = memoryFields(input.detection, input.agentName, changed);
    frame.body.append(...fields.nodes);
    valid = fields.valid;
    options = fields.options;
  }
  prompt.sync();
  frame.body.append(prompt.node, effectSlot);
  if (!input.canWrite) {
    frame.feedback.textContent = t("knowledge.scribes.needsWrite");
    frame.feedback.classList.add("knowledge-muted");
  }
  // Start once with the prompt shown; keep the dialog and its text when the Gateway rejects it.
  async function run() {
    if (starting || submit.disabled) {
      return;
    }
    starting = true;
    refresh();
    frame.feedback.textContent = "";
    frame.feedback.className = "knowledge-dialog-feedback";
    try {
      await input.start(prompt.value());
      frame.close();
    } catch (error) {
      frame.feedback.textContent = t("knowledge.scribeDialog.startFailed", {
        details: error instanceof Error ? error.message : String(error),
      });
      frame.feedback.classList.add("knowledge-error");
    } finally {
      starting = false;
      if (frame.dialog.open) {
        refresh();
      }
    }
  }
  frame.footer.append(
    button(t("knowledge.common.cancel"), () => frame.close(), "knowledge-quiet"),
    submit,
  );
  show(frame.dialog);
  refresh();
  (frame.dialog.querySelector<HTMLElement>("input:not(:disabled)") ?? submit).focus();
  return frame.dialog;
}

/** Confirm a destructive scribe control; `confirm` rejecting keeps the dialog with its error. */
export function openConfirmDialog(
  title: string,
  text: string,
  confirmLabel: string,
  confirm: () => Promise<void>,
) {
  const frame = dialogFrame(title);
  frame.body.append(el("p", text, "scribe-dialog-blurb"));
  const submit = button(
    confirmLabel,
    () => {
      submit.disabled = true;
      frame.feedback.textContent = "";
      frame.feedback.className = "knowledge-dialog-feedback";
      confirm().then(
        () => frame.close(),
        (error: unknown) => {
          submit.disabled = false;
          frame.feedback.textContent = error instanceof Error ? error.message : String(error);
          frame.feedback.classList.add("knowledge-error");
        },
      );
    },
    "knowledge-button knowledge-primary",
  );
  frame.footer.append(
    button(t("knowledge.common.cancel"), () => frame.close(), "knowledge-quiet"),
    submit,
  );
  show(frame.dialog);
  submit.focus();
  return frame.dialog;
}
