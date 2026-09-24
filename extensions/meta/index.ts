/**
 * Meta provider plugin entrypoint.
 */
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyMetaConnectionConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildMetaProvider } from "./provider-catalog.js";
import { wrapMetaProviderStream } from "./stream.js";
import { resolveMetaThinkingProfile } from "./thinking.js";

const PROVIDER_ID = "meta";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Meta Provider",
  description: "Meta provider plugin",
  manifest,
  provider: {
    label: "Meta",
    docsPath: "/providers/meta",
    manifestAuth: {
      applyConfig: applyMetaConnectionConfig,
      noteMessage: "Meta provides Responses API inference.",
      noteTitle: "Meta",
    },
    catalog: {
      discoveryMode: "strict",
      buildProvider: buildMetaProvider,
      buildStaticProvider: buildMetaProvider,
      liveModelDiscovery: true,
    },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    wrapSimpleCompletionStreamFn: wrapMetaProviderStream,
    wrapStreamFn: wrapMetaProviderStream,
    resolveThinkingProfile: resolveMetaThinkingProfile,
  },
});
