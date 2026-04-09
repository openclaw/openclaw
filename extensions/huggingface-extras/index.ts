// Plugin entrypoint for huggingface-extras.
//
// Registers a `huggingface-extras` provider with three contracts on top of
// the Hugging Face Inference Providers router:
//   - image generation (FLUX / SDXL via the hf-inference route)
//   - memory embeddings (Qwen3-Embedding-8B via the scaleway route)
//   - audio transcription / STT (whisper-large-v3 via the hf-inference route)
//
// All three share the same HF API token and onboarding choice. We do not
// register chat completion here because the existing `huggingface` plugin
// already covers that via the OpenAI-compatible router.

import { PROVIDER_ID, createProviderApiKeyAuthMethod, definePluginEntry } from "./api.js";
import { huggingFaceExtrasMemoryEmbeddingProviderAdapter } from "./embeddings-provider.js";
import { buildHuggingFaceExtrasImageGenerationProvider } from "./image-generation-provider.js";
import { huggingFaceExtrasMediaUnderstandingProvider } from "./stt-provider.js";
import { buildHuggingFaceExtrasVideoGenerationProvider } from "./video-generation-provider.js";

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
    api.registerMemoryEmbeddingProvider(huggingFaceExtrasMemoryEmbeddingProviderAdapter);
    api.registerMediaUnderstandingProvider(huggingFaceExtrasMediaUnderstandingProvider);
    api.registerVideoGenerationProvider(buildHuggingFaceExtrasVideoGenerationProvider());
  },
});
