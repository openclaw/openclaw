import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { WorkerProfileSuggestionDiscovery } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { createCrabboxProfileSuggestionDiscovery } from "./src/crabbox-worker-profile-suggestion.js";

const discovery = createPluginRuntimeStore<WorkerProfileSuggestionDiscovery>({
  key: "crabbox:worker-profile-discovery",
  errorMessage: "Crabbox profile discovery has not initialized",
});

export const discoverWorkerProfile: WorkerProfileSuggestionDiscovery = (params) => {
  let resolve = discovery.tryGetRuntime();
  if (!resolve) {
    const log = createSubsystemLogger("crabbox");
    resolve = createCrabboxProfileSuggestionDiscovery({ warn: (message) => log.warn(message) });
    discovery.setRuntime(resolve);
  }
  return resolve(params);
};
