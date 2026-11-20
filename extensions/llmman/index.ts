import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "llmman";
const LLMMAN_DEFAULT_BASE_URL = "http://127.0.0.1:17434/v1";

// llmman reports models as fully qualified references. docker.io is the default host, ai the
// default namespace, and latest the default tag, so docker.io/ai/gemma4:latest reads as gemma4.
// Any other host, namespace, or tag stays visible. Only the display name changes; the id is what
// the server expects.
const DEFAULT_HOST_PREFIX = "docker.io/";
const DEFAULT_NAMESPACE_PREFIX = "ai/";
const DEFAULT_TAG_SUFFIX = ":latest";

export function formatLlmmanModelName(id: string): string {
  let name = id;
  if (name.startsWith(DEFAULT_HOST_PREFIX) && name.length > DEFAULT_HOST_PREFIX.length) {
    name = name.slice(DEFAULT_HOST_PREFIX.length);
    if (
      name.startsWith(DEFAULT_NAMESPACE_PREFIX) &&
      name.length > DEFAULT_NAMESPACE_PREFIX.length
    ) {
      name = name.slice(DEFAULT_NAMESPACE_PREFIX.length);
    }
  }
  if (name.endsWith(DEFAULT_TAG_SUFFIX) && name.length > DEFAULT_TAG_SUFFIX.length) {
    name = name.slice(0, -DEFAULT_TAG_SUFFIX.length);
  }
  return name;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "llmman Provider",
  description: "Bundled llmman provider plugin",
  manifest,
  provider: {
    label: "llmman",
    docsPath: "/providers/llmman",
    manifestAuth: {
      promptMessage: "Enter llmman API key (llmman-local for a local server)",
      noteTitle: "llmman",
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
        // Catalog discovery runs under a deadline; keep setup code out of its import.
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
              label: "llmman",
              discoverRuntimeContext: false,
            });
            // Keep a display name the server supplied; otherwise shorten the reference.
            // These objects were just built by discovery, so setting the name in place is safe.
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
