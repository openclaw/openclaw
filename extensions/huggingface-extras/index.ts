// Plugin entrypoint for huggingface-extras.
//
// Phase 1 scope: register a `huggingface-extras` provider with API-key auth
// and an image-generation contract backed by the HF Inference API.
// Phases 2 and 3 (embeddings + speech) will register additional contracts
// against the same provider id without changing the auth surface.

import { PROVIDER_ID, createProviderApiKeyAuthMethod, definePluginEntry } from "./api.js";
import { buildHuggingFaceExtrasImageGenerationProvider } from "./image-generation-provider.js";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Hugging Face Extras Provider",
  description:
    "Hugging Face Inference API provider for image generation, embeddings, and speech (complements the chat-only huggingface plugin).",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Hugging Face (Extras)",
      docsPath: "/providers/huggingface",
      envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Hugging Face API key (extras)",
          hint: "Image / embeddings / speech via HF Inference API",
          optionKey: "huggingfaceExtrasApiKey",
          flagName: "--huggingface-extras-api-key",
          envVar: "HUGGINGFACE_HUB_TOKEN",
          promptMessage: "Enter Hugging Face API key (HF token)",
          expectedProviders: [PROVIDER_ID],
          wizard: {
            choiceId: "huggingface-extras-api-key",
            choiceLabel: "Hugging Face API key (extras)",
            choiceHint: "Image / embeddings / speech via HF Inference API",
            groupId: "huggingface-extras",
            groupLabel: "Hugging Face (Extras)",
            groupHint: "Image / embeddings / speech via HF Inference API",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
    });
    api.registerImageGenerationProvider(buildHuggingFaceExtrasImageGenerationProvider());
  },
});
