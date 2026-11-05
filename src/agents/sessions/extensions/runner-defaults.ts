import { interactiveAgentTheme as theme } from "../../modes/interactive/theme/theme.js";
import type { ExtensionCommandContextActions, ExtensionUIContext } from "./types.js";

export const noOpUIContext: ExtensionUIContext = {
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  notify: () => {},
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setWorkingVisible: () => {},
  setWorkingIndicator: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
  // SAFETY: This headless adapter returns no result and never invokes the generic UI renderer.
  custom: async () => undefined as never,
  pasteToEditor: () => {},
  setEditorText: () => {},
  getEditorText: () => "",
  editor: async () => undefined,
  addAutocompleteProvider: () => {},
  setEditorComponent: () => {},
  getEditorComponent: () => undefined,
  get theme() {
    return theme;
  },
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: false, error: "UI not available" }),
  getToolsExpanded: () => false,
  setToolsExpanded: () => {},
};

export const noOpCommandContextActions: ExtensionCommandContextActions = {
  waitForIdle: async () => {},
  newSession: async () => ({ cancelled: false }),
  fork: async () => ({ cancelled: false }),
  navigateTree: async () => ({ cancelled: false }),
  switchSession: async () => ({ cancelled: false }),
  reload: async () => {},
};
