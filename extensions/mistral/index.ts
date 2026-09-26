import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyMistralModelCompat } from "./api.js";
import { mistralMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { mistralMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { applyMistralConnectionConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { resolveThinkingProfile } from "./provider-policy-api.js";
import { buildMistralRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const PROVIDER_ID = "mistral";
export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Mistral Provider",
  description: "Official Mistral provider plugin",
  manifest,
  provider: {
    label: "Mistral",
    docsPath: "/providers/models",
    manifestAuth: { applyConfig: applyMistralConnectionConfig },
    catalog: {
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
    },
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bmistral\b.*(?:input.*too long|token limit.*exceeded)/i.test(errorMessage),
    normalizeResolvedModel: ({ model }) => applyMistralModelCompat(model),
    resolveThinkingProfile,
    buildReplayPolicy: () => ({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict9",
    }),
  },
  register(api) {
    api.registerEmbeddingProvider(mistralMemoryEmbeddingProviderAdapter);
    api.registerMediaUnderstandingProvider(mistralMediaUnderstandingProvider);
    api.registerRealtimeTranscriptionProvider(buildMistralRealtimeTranscriptionProvider);
  },
});
