// Opencode Go provider module exposes offline catalog metadata to core discovery.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildStaticOpencodeGoCompatProviderConfig } from "./provider-catalog.js";

export function buildBundledStaticProviderConfig(): ModelProviderConfig {
  return buildStaticOpencodeGoCompatProviderConfig();
}

const opencodeGoProviderDiscovery: ProviderPlugin = {
  id: "opencode-go",
  label: "OpenCode Go",
  docsPath: "/providers/models",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildBundledStaticProviderConfig(),
    }),
  },
};

export default opencodeGoProviderDiscovery;
