import type { BrowserProfileCapabilities } from "./browser/profile-capabilities.js";

type BrowserToolActionMetadata = {
  tabBoundOrder?: number;
  capability?: keyof BrowserProfileCapabilities;
  lifecycle?: true;
  path?: true;
};

// Normal and run-bound action orders are both exposed in the tool description.
const definitions = {
  doctor: { lifecycle: true },
  status: { lifecycle: true },
  start: { lifecycle: true },
  stop: { lifecycle: true },
  profiles: { lifecycle: true },
  importprofile: { lifecycle: true },
  tabs: { tabBoundOrder: 14 },
  open: {},
  focus: { tabBoundOrder: 9 },
  close: { tabBoundOrder: 1 },
  snapshot: { tabBoundOrder: 13 },
  screenshot: { tabBoundOrder: 12, capability: "supportsScreenshots", path: true },
  navigate: { tabBoundOrder: 10 },
  console: { tabBoundOrder: 2, capability: "supportsConsole" },
  requests: { tabBoundOrder: 3, capability: "supportsRequests" },
  errors: { tabBoundOrder: 4, capability: "supportsErrors" },
  text: { tabBoundOrder: 5, capability: "supportsPageText" },
  emulate: { tabBoundOrder: 6, capability: "supportsEmulation" },
  pdf: { tabBoundOrder: 11, capability: "supportsPdf", path: true },
  download: { tabBoundOrder: 8, capability: "supportsDownloads", path: true },
  waitfordownload: { tabBoundOrder: 16, capability: "supportsDownloads", path: true },
  upload: { tabBoundOrder: 15, capability: "supportsUploads" },
  dialog: { tabBoundOrder: 7, capability: "supportsDialogs" },
  act: { tabBoundOrder: 0 },
} as const satisfies Record<string, BrowserToolActionMetadata>;

export type BrowserToolAction = keyof typeof definitions;
type BrowserLifecycleAction = {
  [K in BrowserToolAction]: (typeof definitions)[K] extends { lifecycle: true } ? K : never;
}[BrowserToolAction];

export const BROWSER_TOOL_ACTION_FACTS: Record<BrowserToolAction, BrowserToolActionMetadata> =
  definitions;
// SAFETY: BrowserToolAction is derived from this exact table's keys.
export const BROWSER_TOOL_ACTIONS = Object.keys(definitions) as BrowserToolAction[];
export const BROWSER_TAB_BOUND_ACTIONS = BROWSER_TOOL_ACTIONS.filter(
  (action) => BROWSER_TOOL_ACTION_FACTS[action].tabBoundOrder !== undefined,
).toSorted(
  (left, right) =>
    BROWSER_TOOL_ACTION_FACTS[left].tabBoundOrder! -
    BROWSER_TOOL_ACTION_FACTS[right].tabBoundOrder!,
);

export function isBrowserLifecycleAction(action: string): action is BrowserLifecycleAction {
  return (
    Object.hasOwn(definitions, action) &&
    // SAFETY: The preceding own-key check admits only BrowserToolAction keys.
    BROWSER_TOOL_ACTION_FACTS[action as BrowserToolAction].lifecycle === true
  );
}
