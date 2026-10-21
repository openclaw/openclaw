import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { transcribeOpenAiCompatibleAudio } from "openclaw/plugin-sdk/media-understanding";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const DEFAULT_GROQ_AUDIO_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_AUDIO_MODEL = "whisper-large-v3-turbo";

function wrapGroqParsedReasoning(streamFn: StreamFn | undefined): StreamFn {
  return createPayloadPatchStreamWrapper(streamFn, ({ model, payload }) => {
    if (model.id.startsWith("qwen/") && model.reasoning && payload.reasoning_effort !== "none") {
      // Groq Qwen otherwise inlines reasoning in visible content; GPT OSS has a separate contract.
      payload.reasoning_format = "parsed";
    }
  });
}

export default defineSingleProviderPluginEntry({
  id: "groq",
  name: "Groq Provider",
  description: "Bundled Groq provider plugin",
  manifest,
  provider: {
    label: "Groq",
    docsPath: "/providers/groq",
    catalog: { liveModelDiscovery: true, discoveryMode: "strict" },
    wrapStreamFn: (ctx) => wrapGroqParsedReasoning(ctx.streamFn),
    wrapSimpleCompletionStreamFn: (ctx) => wrapGroqParsedReasoning(ctx.streamFn),
  },
  register(api) {
    api.registerMediaUnderstandingProvider({
      id: "groq",
      capabilities: ["audio"],
      defaultModels: { audio: DEFAULT_GROQ_AUDIO_MODEL },
      autoPriority: { audio: 20 },
      transcribeAudio: (req) =>
        transcribeOpenAiCompatibleAudio({
          ...req,
          baseUrl: req.baseUrl ?? DEFAULT_GROQ_AUDIO_BASE_URL,
          defaultBaseUrl: DEFAULT_GROQ_AUDIO_BASE_URL,
          defaultModel: DEFAULT_GROQ_AUDIO_MODEL,
        }),
    });
  },
});
