import {
  normalizeTrimmedStringList,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  QA_BASE_RUNTIME_PLUGIN_IDS,
  QA_CODEX_OPENAI_CATALOG_BASE_URL,
} from "../qa-gateway-config.js";
import type { RuntimeId } from "../runtime-id.js";
import type { QaProviderMode } from "./index.js";
import { getQaProvider, QA_DEFAULT_IMAGE_MODEL } from "./index.js";

type QaImageGenerationPatchInput = {
  providerMode: QaProviderMode;
  providerBaseUrl?: string;
  requiredPluginIds: readonly string[];
  existingPluginIds?: readonly string[];
  forcedRuntime?: RuntimeId;
};

export function buildQaImageGenerationConfigPatch(input: QaImageGenerationPatchInput) {
  const provider = getQaProvider(input.providerMode);
  const modelPatch = (() => {
    if (provider.kind !== "mock") {
      return null;
    }
    if (!input.providerBaseUrl) {
      throw new Error(`QA provider "${input.providerMode}" requires a mock provider URL`);
    }
    const gatewayModels = provider.buildGatewayModels({
      providerBaseUrl: input.providerBaseUrl,
    });
    if (input.forcedRuntime !== "codex" || input.providerMode !== "mock-openai") {
      return gatewayModels;
    }
    const openAiCatalog = gatewayModels?.providers.openai;
    if (!openAiCatalog) {
      throw new Error("forced Codex mock image QA requires the OpenAI mock catalog");
    }
    return {
      mode: "merge" as const,
      providers: {
        openai: {
          ...openAiCatalog,
          baseUrl: QA_CODEX_OPENAI_CATALOG_BASE_URL,
          request: undefined,
          models: openAiCatalog.models.map((model) =>
            model.id === "gpt-image-1"
              ? Object.assign({}, model, { baseUrl: input.providerBaseUrl })
              : model,
          ),
        },
      },
    };
  })();
  return {
    plugins: {
      allow: uniqueStrings(
        normalizeTrimmedStringList([
          ...QA_BASE_RUNTIME_PLUGIN_IDS,
          ...(input.existingPluginIds ?? []),
          "openai",
          ...input.requiredPluginIds,
        ]),
      ),
      entries: { openai: { enabled: true } },
    },
    ...(modelPatch ? { models: modelPatch } : {}),
    agents: {
      defaults: {
        mediaModels: {
          image: {
            primary: QA_DEFAULT_IMAGE_MODEL,
          },
        },
      },
    },
  };
}
