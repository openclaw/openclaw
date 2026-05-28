import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildClaudeProviderConfig,
  CLAUDE_APP_SERVER_AUTH_MARKER,
  CLAUDE_PROVIDER_ID,
  FALLBACK_CLAUDE_MODELS,
} from "./provider-catalog.js";

export const claudeProviderDiscovery: ProviderPlugin = {
  id: CLAUDE_PROVIDER_ID,
  label: "Claude",
  docsPath: "/providers/models",
  auth: [],
  staticCatalog: {
    order: "late",
    run: async () => ({
      provider: buildClaudeProviderConfig(FALLBACK_CLAUDE_MODELS),
    }),
  },
  resolveSyntheticAuth: () => ({
    apiKey: CLAUDE_APP_SERVER_AUTH_MARKER,
    source: "claude-app-server",
    mode: "token",
  }),
};

export default claudeProviderDiscovery;
