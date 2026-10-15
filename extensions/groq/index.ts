import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { groqMediaUnderstandingProvider } from "./media-understanding-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

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
    api.registerMediaUnderstandingProvider(groqMediaUnderstandingProvider);
  },
});
