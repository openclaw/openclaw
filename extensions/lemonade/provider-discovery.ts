import type { ProviderDiscoveryEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildOllamaProvider } from "../ollama/api.js";
import { resolveLemonadeDiscoveryResult } from "./src/discovery-shared.js";

export default {
  id: "lemonade",
  run: async (ctx) =>
    await resolveLemonadeDiscoveryResult({
      ctx,
      pluginConfig: (ctx.pluginConfig ?? {}) as { discovery?: { enabled?: boolean } },
      buildProvider: buildOllamaProvider,
    }),
} satisfies ProviderDiscoveryEntry;
