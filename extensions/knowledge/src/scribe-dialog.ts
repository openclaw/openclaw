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
const PLUGIN_STATE: Record<PluginReadiness, (name: string) => string> = {
  missing: (name) => `Needs the ${name} plugin, which is not installed`,
  disabled: (name) => `Needs the ${name} plugin, which is turned off`,
  "needs-sign-in": (name) => `${name} plugin installed, not connected to your ${name} account`,
  ready: (name) => `${name} connected`,
};
/** One line for a needed plugin's readiness. */
export const pluginStateText = (plugin: ScribePlugin, readiness: PluginReadiness) =>
  PLUGIN_STATE[readiness](plugin.name);

// The control that fixes a needed plugin, by readiness; a ready plugin needs none.
const PLUGIN_ACTION: Record<Exclude<PluginReadiness, "ready">, (name: string) => string> = {
  missing: (name) => `Install ${name}…`,
  disabled: (name) => `Turn on ${name}…`,
  "needs-sign-in": (name) => `Connect ${name}…`,
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
    PLUGIN_ACTION[readiness](plugin.name),
    () => window.location.assign(href),
    className,
  );
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

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
  closeButton.setAttribute("aria-label", "Close");
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
  often.append(el("legend", "How often"));
  often.append(
    choice(
      "radio",
      "scribe-often-ongoing",
      "Keep learning",
      "Checks for newly finished conversations every day at 4:00 AM.",
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
      "Once",
      "Works through the conversations below, then stops.",
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
  which.append(el("legend", "Which conversations"));
  which.append(
    choice(
      "radio",
      "scribe-which-active",
      "Active conversations",
      active === undefined
        ? "Conversations in your sidebar."
        : `${count(active, "conversation")} in your sidebar.`,
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
      "Active and archived",
      `${active === undefined || archived === undefined ? "Includes archived conversations." : count(active + archived, "conversation") + "."} The first pass takes longer and uses more tokens.`,
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
  const labels: Record<ConversationSince, string> = {
    "30d": "The last 30 days",
    "90d": "The last 90 days",
    all: "The beginning",
    today: "Today (new conversations only)",
  };
  for (const value of SINCE) {
    const text = labels[value];
    const option = el("option", text);
    option.value = value;
    select.append(option);
  }
  select.addEventListener("change", () => {
    state.since = SINCE.find((value) => value === select.value) ?? "30d";
    changed();
  });
  since.append(
    el("span", "Starting from"),
    select,
    el("small", "Conversations already learned from are skipped."),
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
    el("legend", "How often"),
    choice(
      "radio",
      "scribe-granola-ongoing",
      "Keep learning",
      "Checks for finished meetings on weekdays at 10 AM, 2 PM and 6 PM.",
      false,
      set({ mode: "ongoing" }),
      true,
      "scribe-granola-often",
    ),
    choice(
      "radio",
      "scribe-granola-once",
      "Once",
      "Works through the meetings below, then stops.",
      false,
      set({ mode: "once" }),
      false,
      "scribe-granola-often",
    ),
  );
  const which = el("fieldset", undefined, "knowledge-choices");
  which.append(
    el("legend", "Which meetings"),
    choice(
      "radio",
      "scribe-granola-mine",
      "Your meetings",
      "Meetings you recorded or were invited to.",
      false,
      set({ meetings: "mine" }),
      true,
      "scribe-granola-which",
    ),
    choice(
      "radio",
      "scribe-granola-all",
      "Every meeting you can read",
      "Also notes others shared with you and Team Space meetings.",
      false,
      set({ meetings: "all" }),
      false,
      "scribe-granola-which",
    ),
  );
  const since = el("label", undefined, "knowledge-field");
  const select = el("select", undefined, "scribe-select");
  const labels: Record<GranolaSince, string> = {
    "7d": "The last 7 days",
    "30d": "The last 30 days",
    today: "Today (new meetings only)",
  };
  for (const value of GRANOLA_SINCE) {
    const option = el("option", labels[value]);
    option.value = value;
    select.append(option);
  }
  select.addEventListener("change", () => {
    state.since = GRANOLA_SINCE.find((value) => value === select.value) ?? "7d";
    changed();
  });
  since.append(
    el("span", "Starting from"),
    select,
    el("small", "Meetings already in Knowledge are skipped. Each meeting takes a few minutes."),
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
        ? `${state}. This scribe reads through the ${scribe.plugin.name} plugin.`
        : `${state}. Connect it before starting this scribe.`,
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
  often.append(el("legend", "How often"));
  often.append(
    choice(
      "radio",
      "scribe-review-weekly",
      "Weekly",
      "Sundays at 3:45 AM.",
      false,
      pick(REVIEW_WEEKLY_SCHEDULE),
      true,
      "scribe-review-often",
    ),
    choice(
      "radio",
      "scribe-review-nightly",
      "Nightly",
      "Every day at 3:45 AM, after maintenance links what it can. Each run is an agent turn over every unlinked claim, so it uses more tokens.",
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
      ? `Not found in ${agentName}’s workspace.`
      : file?.size !== undefined
        ? `${Math.max(1, Math.round(file.size / 1024)).toLocaleString()} KB in ${agentName}’s workspace.`
        : "Long-term memory in the workspace.";
  const picks = el("fieldset", undefined, "knowledge-choices");
  picks.append(el("legend", "What to bring in"));
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
      "Daily notes",
      "Files in memory/.",
      false,
      toggle("daily-notes"),
      true,
    ),
    choice(
      "checkbox",
      "scribe-memory-dreams",
      "Dreaming diary",
      "DREAMS.md. Mostly summaries of the above.",
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
  lead.append(
    "Knowledge will start a conversation called ",
    el("strong", scribeLabel(scribe)),
    ` as you, with ${storeName}’s private access, and send it the prompt above. `,
    mode === "once"
      ? `It works through ${scribe.id === "memory" ? "Memory" : "them"} once and reports back here. Nothing is scheduled.`
      : scribe.id === "claim-consolidation"
        ? "It sets up its own schedule and does one test run first."
        : "If you keep it learning, it sets up its own schedule and does one test run first.",
  );
  effect.append(
    lead,
    el(
      "p",
      `Uses ${input.agentName}’s default model. You can read everything it does in that conversation${mode === "once" ? "." : ", and pause or turn it off from Scribes."}`,
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
  text.setAttribute("aria-label", "Prompt");
  const note = el("small");
  let edited = false;
  const sync = () => {
    if (!edited) {
      text.value = generate();
    }
    note.textContent = edited
      ? "Edited by hand. Changing a choice above no longer updates it."
      : "Generated from your choices. Edit it to change what the scribe is told.";
    reset.hidden = !edited;
  };
  const reset = button(
    "Use generated prompt",
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
  details.append(el("summary", "Prompt"), text, foot);
  return { node: details, sync, value: () => text.value, edited: () => edited };
}

/** Open the start dialog for one scribe. Starting is disabled without write access. */
export function openStartDialog(input: StartDialogInput) {
  const { scribe } = input;
  const frame = dialogFrame(scribe.dialogTitle, scribeTile(scribe));
  const effectSlot = el("div");
  let mode: () => ScribeMode = () => scribe.modes[0]!;
  let options: () => ScribeOptions[ScribeId] = () => defaultOptions(scribe.id);
  let valid = () => true;
  let pluginReady = true;
  let starting = false;
  const submit = button(scribe.submitLabel, () => void run(), "knowledge-button knowledge-primary");
  // A needed plugin must be ready. A hand-edited prompt then only needs text; a generated one
  // needs valid choices.
  const ready = () => pluginReady && (prompt.edited() ? Boolean(prompt.value().trim()) : valid());
  const refresh = () => {
    submit.disabled = starting || !input.canWrite || !ready();
    submit.textContent = starting ? "Starting…" : scribe.submitLabel;
    effectSlot.replaceChildren(effectText(input, mode()));
  };
  const prompt = promptField(() => setupPrompt(scribeSetup(scribe.id, mode(), options())), refresh);
  // A changed choice regenerates the prompt unless it was edited by hand.
  const changed = () => {
    prompt.sync();
    refresh();
  };
  frame.body.append(el("p", scribe.blurb, "scribe-dialog-blurb"));
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
    frame.feedback.textContent = "Starting a scribe needs write access to this Gateway.";
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
      frame.feedback.textContent = `The scribe was not started. ${error instanceof Error ? error.message : String(error)}`;
      frame.feedback.classList.add("knowledge-error");
    } finally {
      starting = false;
      if (frame.dialog.open) {
        refresh();
      }
    }
  }
  frame.footer.append(
    button("Cancel", () => frame.close(), "knowledge-quiet"),
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
    button("Cancel", () => frame.close(), "knowledge-quiet"),
    submit,
  );
  show(frame.dialog);
  submit.focus();
  return frame.dialog;
}
