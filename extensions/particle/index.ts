import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyParticleConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export default defineSingleProviderPluginEntry({
  id: "particle",
  name: "Particle Provider",
  description: "Particle model provider",
  manifest,
  provider: {
    label: "Particle",
    docsPath: "/providers/particle",
    manifestAuth: { applyConfig: applyParticleConfig },
    catalog: { liveModelDiscovery: true, discoveryMode: "strict" },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
  },
});
