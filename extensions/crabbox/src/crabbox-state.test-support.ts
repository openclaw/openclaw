import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { CrabboxState } from "./crabbox-worker-warm-image-store.js";

export const crabboxState: CrabboxState = {
  openKeyedStore: (options) => createPluginStateKeyedStoreForTests("crabbox", options),
};
