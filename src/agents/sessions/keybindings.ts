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
import { getAgentDir } from "../config.js";

/** OpenClaw-specific key ids added to the shared pi-tui keybinding registry. */
type AppKeybindings = Record<Exclude<keyof typeof KEYBINDINGS, keyof typeof TUI_KEYBINDINGS>, true>;

declare module "@earendil-works/pi-tui" {
  interface Keybindings extends AppKeybindings {}
}

/** Complete keybinding definition map consumed by the TUI keybinding manager. */
const KEYBINDINGS = {
  ...TUI_KEYBINDINGS,
  "app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
  "app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
  "app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
  "app.suspend": {
    defaultKeys: process.platform === "win32" ? [] : "ctrl+z",
    description: "Suspend to background",
  },
  "app.thinking.cycle": {
    defaultKeys: "shift+tab",
    description: "Cycle thinking level",
  },
  "app.model.cycleForward": {
    defaultKeys: "ctrl+p",
    description: "Cycle to next model",
  },
  "app.model.cycleBackward": {
    defaultKeys: "shift+ctrl+p",
    description: "Cycle to previous model",
  },
  "app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  "app.thinking.toggle": {
    defaultKeys: "ctrl+t",
    description: "Toggle thinking blocks",
  },
  "app.session.toggleNamedFilter": {
    defaultKeys: "ctrl+n",
    description: "Toggle named session filter",
  },
  "app.editor.external": {
    defaultKeys: "ctrl+g",
    description: "Open external editor",
  },
  "app.message.followUp": {
    defaultKeys: "alt+enter",
    description: "Queue follow-up message",
  },
  "app.message.dequeue": {
    defaultKeys: "alt+up",
    description: "Restore queued messages",
  },
  "app.clipboard.pasteImage": {
    defaultKeys: process.platform === "win32" ? "alt+v" : "ctrl+v",
    description: "Paste image from clipboard",
  },
  "app.session.new": { defaultKeys: [], description: "Start a new session" },
  "app.session.tree": { defaultKeys: [], description: "Open session tree" },
  "app.session.fork": { defaultKeys: [], description: "Fork current session" },
  "app.session.resume": { defaultKeys: [], description: "Resume a session" },
  "app.tree.foldOrUp": {
    defaultKeys: ["ctrl+left", "alt+left"],
    description: "Fold tree branch or move up",
  },
  "app.tree.unfoldOrDown": {
    defaultKeys: ["ctrl+right", "alt+right"],
    description: "Unfold tree branch or move down",
  },
  "app.tree.editLabel": {
    defaultKeys: "shift+l",
    description: "Edit tree label",
  },
  "app.tree.toggleLabelTimestamp": {
    defaultKeys: "shift+t",
    description: "Toggle tree label timestamps",
  },
  "app.session.togglePath": {
    defaultKeys: "ctrl+p",
    description: "Toggle session path display",
  },
  "app.session.toggleSort": {
    defaultKeys: "ctrl+s",
    description: "Toggle session sort mode",
  },
  "app.session.rename": {
    defaultKeys: "ctrl+r",
    description: "Rename session",
  },
  "app.session.delete": {
    defaultKeys: "ctrl+d",
    description: "Delete session",
  },
  "app.session.deleteNoninvasive": {
    defaultKeys: "ctrl+backspace",
    description: "Delete session when query is empty",
  },
  "app.models.save": {
    defaultKeys: "ctrl+s",
    description: "Save model selection",
  },
  "app.models.enableAll": {
    defaultKeys: "ctrl+a",
    description: "Enable all models",
  },
  "app.models.clearAll": {
    defaultKeys: "ctrl+x",
    description: "Clear all models",
  },
  "app.models.toggleProvider": {
    defaultKeys: "ctrl+p",
    description: "Toggle all models for provider",
  },
  "app.models.reorderUp": {
    defaultKeys: "alt+up",
    description: "Move model up in order",
  },
  "app.models.reorderDown": {
    defaultKeys: "alt+down",
    description: "Move model down in order",
  },
  "app.tree.filter.default": {
    defaultKeys: "ctrl+d",
    description: "Tree filter: default view",
  },
  "app.tree.filter.noTools": {
    defaultKeys: "ctrl+t",
    description: "Tree filter: hide tool results",
  },
  "app.tree.filter.userOnly": {
    defaultKeys: "ctrl+u",
    description: "Tree filter: user messages only",
  },
  "app.tree.filter.labeledOnly": {
    defaultKeys: "ctrl+l",
    description: "Tree filter: labeled entries only",
  },
  "app.tree.filter.all": {
    defaultKeys: "ctrl+a",
    description: "Tree filter: show all entries",
  },
  "app.tree.filter.cycleForward": {
    defaultKeys: "ctrl+o",
    description: "Tree filter: cycle forward",
  },
  "app.tree.filter.cycleBackward": {
    defaultKeys: "shift+ctrl+o",
    description: "Tree filter: cycle backward",
  },
} as const satisfies KeybindingDefinitions;

/** Validates bindings and orders known entries ahead of unknown extras. */
function parseKeybindingsConfig(rawConfig: Record<string, unknown>): KeybindingsConfig {
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
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      return isRecord(parsed) ? parseKeybindingsConfig(parsed) : {};
    } catch {
      return {};
    }
  }
}

export type { KeybindingsConfig };
