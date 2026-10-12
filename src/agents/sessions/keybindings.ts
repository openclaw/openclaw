/**
 * Application keybinding definitions and user-config loading.
 *
 * Wraps pi-tui keybindings with OpenClaw-specific actions and per-agent overrides.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type KeybindingDefinitions,
  type KeybindingsConfig,
  type KeyId,
  TUI_KEYBINDINGS,
  KeybindingsManager as TuiKeybindingsManager,
} from "@earendil-works/pi-tui";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createInvalidConfigError } from "../../config/io.invalid-config.js";
import { getAgentDir } from "../config.js";

/** OpenClaw-specific key ids added to the shared pi-tui keybinding registry. */
type AppKeybindings = Record<keyof typeof APP_KEYBINDINGS, true>;

declare module "@earendil-works/pi-tui" {
  interface Keybindings extends AppKeybindings {}
}

/** Application actions with their default keys and display descriptions. */
const APP_KEYBINDINGS = {
  "app.interrupt": ["escape", "Cancel or abort"],
  "app.clear": ["ctrl+c", "Clear editor"],
  "app.exit": ["ctrl+d", "Exit when editor is empty"],
  "app.suspend": [process.platform === "win32" ? [] : "ctrl+z", "Suspend to background"],
  "app.thinking.cycle": ["shift+tab", "Cycle thinking level"],
  "app.model.cycleForward": ["ctrl+p", "Cycle to next model"],
  "app.model.cycleBackward": ["shift+ctrl+p", "Cycle to previous model"],
  "app.model.select": ["ctrl+l", "Open model selector"],
  "app.tools.expand": ["ctrl+o", "Toggle tool output"],
  "app.thinking.toggle": ["ctrl+t", "Toggle thinking blocks"],
  "app.session.toggleNamedFilter": ["ctrl+n", "Toggle named session filter"],
  "app.editor.external": ["ctrl+g", "Open external editor"],
  "app.message.followUp": ["alt+enter", "Queue follow-up message"],
  "app.message.dequeue": ["alt+up", "Restore queued messages"],
  "app.clipboard.pasteImage": [
    process.platform === "win32" ? "alt+v" : "ctrl+v",
    "Paste image from clipboard",
  ],
  "app.session.new": [[], "Start a new session"],
  "app.session.tree": [[], "Open session tree"],
  "app.session.fork": [[], "Fork current session"],
  "app.session.resume": [[], "Resume a session"],
  "app.tree.foldOrUp": [["ctrl+left", "alt+left"], "Fold tree branch or move up"],
  "app.tree.unfoldOrDown": [["ctrl+right", "alt+right"], "Unfold tree branch or move down"],
  "app.tree.editLabel": ["shift+l", "Edit tree label"],
  "app.tree.toggleLabelTimestamp": ["shift+t", "Toggle tree label timestamps"],
  "app.session.togglePath": ["ctrl+p", "Toggle session path display"],
  "app.session.toggleSort": ["ctrl+s", "Toggle session sort mode"],
  "app.session.rename": ["ctrl+r", "Rename session"],
  "app.session.delete": ["ctrl+d", "Delete session"],
  "app.session.deleteNoninvasive": ["ctrl+backspace", "Delete session when query is empty"],
  "app.models.save": ["ctrl+s", "Save model selection"],
  "app.models.enableAll": ["ctrl+a", "Enable all models"],
  "app.models.clearAll": ["ctrl+x", "Clear all models"],
  "app.models.toggleProvider": ["ctrl+p", "Toggle all models for provider"],
  "app.models.reorderUp": ["alt+up", "Move model up in order"],
  "app.models.reorderDown": ["alt+down", "Move model down in order"],
  "app.tree.filter.default": ["ctrl+d", "Tree filter: default view"],
  "app.tree.filter.noTools": ["ctrl+t", "Tree filter: hide tool results"],
  "app.tree.filter.userOnly": ["ctrl+u", "Tree filter: user messages only"],
  "app.tree.filter.labeledOnly": ["ctrl+l", "Tree filter: labeled entries only"],
  "app.tree.filter.all": ["ctrl+a", "Tree filter: show all entries"],
  "app.tree.filter.cycleForward": ["ctrl+o", "Tree filter: cycle forward"],
  "app.tree.filter.cycleBackward": ["shift+ctrl+o", "Tree filter: cycle backward"],
} as const satisfies Record<string, [KeyId | KeyId[], string]>;

/** Complete keybinding definition map consumed by the TUI keybinding manager. */
const KEYBINDINGS = {
  ...TUI_KEYBINDINGS,
  ...Object.fromEntries(
    Object.entries(APP_KEYBINDINGS).map(([action, [defaultKeys, description]]) => [
      action,
      { defaultKeys, description },
    ]),
  ),
} satisfies KeybindingDefinitions;

const RETIRED_KEYBINDING_NAMES = {
  cursorUp: "tui.editor.cursorUp",
  cursorDown: "tui.editor.cursorDown",
  cursorLeft: "tui.editor.cursorLeft",
  cursorRight: "tui.editor.cursorRight",
  cursorWordLeft: "tui.editor.cursorWordLeft",
  cursorWordRight: "tui.editor.cursorWordRight",
  cursorLineStart: "tui.editor.cursorLineStart",
  cursorLineEnd: "tui.editor.cursorLineEnd",
  jumpForward: "tui.editor.jumpForward",
  jumpBackward: "tui.editor.jumpBackward",
  pageUp: "tui.editor.pageUp",
  pageDown: "tui.editor.pageDown",
  deleteCharBackward: "tui.editor.deleteCharBackward",
  deleteCharForward: "tui.editor.deleteCharForward",
  deleteWordBackward: "tui.editor.deleteWordBackward",
  deleteWordForward: "tui.editor.deleteWordForward",
  deleteToLineStart: "tui.editor.deleteToLineStart",
  deleteToLineEnd: "tui.editor.deleteToLineEnd",
  yank: "tui.editor.yank",
  yankPop: "tui.editor.yankPop",
  undo: "tui.editor.undo",
  newLine: "tui.input.newLine",
  submit: "tui.input.submit",
  tab: "tui.input.tab",
  copy: "tui.input.copy",
  selectUp: "tui.select.up",
  selectDown: "tui.select.down",
  selectPageUp: "tui.select.pageUp",
  selectPageDown: "tui.select.pageDown",
  selectConfirm: "tui.select.confirm",
  selectCancel: "tui.select.cancel",
  interrupt: "app.interrupt",
  clear: "app.clear",
  exit: "app.exit",
  suspend: "app.suspend",
  cycleThinkingLevel: "app.thinking.cycle",
  cycleModelForward: "app.model.cycleForward",
  cycleModelBackward: "app.model.cycleBackward",
  selectModel: "app.model.select",
  expandTools: "app.tools.expand",
  toggleThinking: "app.thinking.toggle",
  toggleSessionNamedFilter: "app.session.toggleNamedFilter",
  externalEditor: "app.editor.external",
  followUp: "app.message.followUp",
  dequeue: "app.message.dequeue",
  pasteImage: "app.clipboard.pasteImage",
  newSession: "app.session.new",
  tree: "app.session.tree",
  fork: "app.session.fork",
  resume: "app.session.resume",
  treeFoldOrUp: "app.tree.foldOrUp",
  treeUnfoldOrDown: "app.tree.unfoldOrDown",
  treeEditLabel: "app.tree.editLabel",
  treeToggleLabelTimestamp: "app.tree.toggleLabelTimestamp",
  toggleSessionPath: "app.session.togglePath",
  toggleSessionSort: "app.session.toggleSort",
  renameSession: "app.session.rename",
  deleteSession: "app.session.delete",
  deleteSessionNoninvasive: "app.session.deleteNoninvasive",
} as const satisfies Record<string, keyof typeof APP_KEYBINDINGS | keyof typeof TUI_KEYBINDINGS>;

/** Validates bindings and orders known entries ahead of unknown extras. */
function parseKeybindingsConfig(
  rawConfig: Record<string, unknown>,
  configPath: string,
): KeybindingsConfig {
  const retired = Object.entries(RETIRED_KEYBINDING_NAMES)
    .filter(([name]) => Object.hasOwn(rawConfig, name))
    .map(([name, current]) => `${name}: use ${current}`);
  if (retired.length > 0) {
    throw createInvalidConfigError(
      configPath,
      `Retired keybinding names: ${retired.join("; ")}. ` +
        "Preserve the original file and replace the retired names, keeping bindings that already use the current names when both names occur. " +
        "OpenClaw 2026.9.7 retains the former keybinding reader for a staged upgrade. " +
        "See https://docs.openclaw.ai/gateway/doctor/config-migrations#session-settings.",
      { recovery: "manual" },
    );
  }
  const config = new Map<string, KeyId | KeyId[]>();
  for (const [key, binding] of Object.entries(rawConfig)) {
    if (typeof binding === "string") {
      config.set(key, binding as KeyId);
    } else if (Array.isArray(binding) && binding.every((entry) => typeof entry === "string")) {
      config.set(key, binding as KeyId[]);
    }
  }
  return orderKeybindingsConfig(Object.fromEntries(config));
}

function orderKeybindingsConfig(config: KeybindingsConfig): KeybindingsConfig {
  const known = Object.keys(KEYBINDINGS).filter((key) => Object.hasOwn(config, key));
  const extras = Object.keys(config)
    .filter((key) => !Object.hasOwn(KEYBINDINGS, key))
    .toSorted();
  return Object.fromEntries([...known, ...extras].map((key) => [key, config[key]]));
}

/** Keybinding manager that loads OpenClaw defaults plus optional user overrides. */
export class KeybindingsManager extends TuiKeybindingsManager {
  constructor(
    userBindings: KeybindingsConfig = {},
    private configPath?: string,
  ) {
    super(KEYBINDINGS, userBindings);
  }

  /** Creates a manager from the agent keybindings.json file. */
  static create(agentDir: string = getAgentDir()): KeybindingsManager {
    const configPath = join(agentDir, "keybindings.json");
    const userBindings = KeybindingsManager.loadFromFile(configPath);
    return new KeybindingsManager(userBindings, configPath);
  }

  /** Reloads user overrides from disk when this manager was created with a config path. */
  reload(): void {
    if (!this.configPath) {
      return;
    }
    this.setUserBindings(KeybindingsManager.loadFromFile(this.configPath));
  }

  /** Returns the currently resolved keybinding map after defaults and overrides. */
  getEffectiveConfig(): KeybindingsConfig {
    return this.getResolvedBindings();
  }

  private static loadFromFile(path: string): KeybindingsConfig {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return {};
    }
    return isRecord(parsed) ? parseKeybindingsConfig(parsed, path) : {};
  }
}

export type { KeybindingsConfig };
