import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "llmman";
const LLMMAN_DEFAULT_BASE_URL = "http://127.0.0.1:17434/v1";

// Display name only (ids are unchanged): drop docker.io/, its ai/ namespace and :latest.
export function formatLlmmanModelName(id: string): string {
  return id.replace(/^docker\.io\/(?:ai\/(?=.))?(?=.)/s, "").replace(/(?<=.):latest$/s, "");
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "llmman Provider",
  description: "Bundled llmman provider plugin",
  manifest,
  provider: {
    label: PROVIDER_ID,
    docsPath: "/providers/llmman",
    manifestAuth: {
      promptMessage: "Enter llmman API key (llmman-local for a local server)",
      noteTitle: PROVIDER_ID,
      noteMessage: [
        "llmman serves local models over an OpenAI-compatible API.",
        `OpenClaw looks for it at ${LLMMAN_DEFAULT_BASE_URL}.`,
        "A loopback server needs no key: enter llmman-local.",
        "A server started with LLMMAN_API_KEYS needs one of those keys.",
      ].join("\n"),
    },
    catalog: {
      order: "late",
      run: async (ctx) => {
        // Lazy import keeps setup code out of the discovery deadline.
        const { discoverOpenAICompatibleLocalModels, discoverOpenAICompatibleSelfHostedProvider } =
          await import("openclaw/plugin-sdk/provider-setup");
        return await discoverOpenAICompatibleSelfHostedProvider({
          ctx,
          providerId: PROVIDER_ID,
          buildProvider: async (params) => {
            const baseUrl = (params.baseUrl?.trim() || LLMMAN_DEFAULT_BASE_URL).replace(/\/+$/, "");
            const models = await discoverOpenAICompatibleLocalModels({
              baseUrl,
              apiKey: params.apiKey,
              label: PROVIDER_ID,
              discoverRuntimeContext: false,
            });
            for (const model of models) {
              if (model.name === model.id) {
                model.name = formatLlmmanModelName(model.id);
              }
            }
            return { baseUrl, api: "openai-completions" as const, models };
          },
        });
      },
    },
  },
});
