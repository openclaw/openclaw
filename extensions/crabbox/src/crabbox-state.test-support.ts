import {
  createPluginStateKeyedStoreV2ForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { WarmProfileRecord } from "./crabbox-worker-warm-image-records.js";
import type { CrabboxState } from "./crabbox-worker-warm-image-store.js";

export const crabboxState: CrabboxState = {
  openKeyedStoreV2: (options) =>
    createPluginStateKeyedStoreV2ForTests("crabbox", options, { assertCurrent() {} }),
};

export function openWarmImageStore() {
  return createPluginStateSyncKeyedStoreForTests<WarmProfileRecord>("crabbox", {
    namespace: "warm-images",
    maxEntries: 128,
    overflowPolicy: "reject-new",
  });
}
