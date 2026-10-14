import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { CrabboxState, WarmProfileRecord } from "./crabbox-worker-warm-image-store.js";

export const crabboxState: CrabboxState = {
  openKeyedStore: (options) => createPluginStateKeyedStoreForTests("crabbox", options),
};

export function openWarmImageStore() {
  return createPluginStateSyncKeyedStoreForTests<WarmProfileRecord>("crabbox", {
    namespace: "warm-images",
    maxEntries: 128,
    overflowPolicy: "reject-new",
  });
}
