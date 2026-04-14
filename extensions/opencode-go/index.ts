import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { createOpencodeCatalogApiKeyAuthMethod } from "openclaw/plugin-sdk/opencode";
import {
  definePluginEntry,
  type OpenClawConfig,
  type ProviderAugmentModelCatalogContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { findCatalogTemplate } from "openclaw/plugin-sdk/provider-catalog-shared";
import { PASSTHROUGH_GEMINI_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import { applyOpencodeGoConfig, OPENCODE_GO_DEFAULT_MODEL_REF } from "./api.js";

const PROVIDER_ID = "opencode-go";
const OPENCODE_GO_GLM_5_MODEL_ID = "glm-5";
const OPENCODE_GO_GLM_5_1_MODEL_ID = "glm-5.1";

function buildOpencodeGoForwardCompatCatalogEntry(params: {
  entries: ModelCatalogEntry[];
  modelId: string;
  templateIds: readonly string[];
  name: string;
}): ModelCatalogEntry | null {
  const existing = params.entries.find(
    (entry) => entry.provider === PROVIDER_ID && entry.id === params.modelId,
  );
  if (existing) {
    return null;
  }

  const template = findCatalogTemplate({
    entries: params.entries,
    providerId: PROVIDER_ID,
    templateIds: params.templateIds,
  });
  if (!template) {
    return null;
  }

  return {
    ...template,
    provider: PROVIDER_ID,
    id: params.modelId,
    name: params.name,
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "OpenCode Go Provider",
  description: "Bundled OpenCode Go provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenCode Go",
      docsPath: "/providers/models",
      envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
      auth: [
        createOpencodeCatalogApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          label: "OpenCode Go catalog",
          optionKey: "opencodeGoApiKey",
          flagName: "--opencode-go-api-key",
          defaultModel: OPENCODE_GO_DEFAULT_MODEL_REF,
          applyConfig: (cfg: OpenClawConfig) => applyOpencodeGoConfig(cfg),
          noteMessage: [
            "OpenCode uses one API key across the Zen and Go catalogs.",
            "Go focuses on Kimi, GLM, and MiniMax coding models.",
            "Get your API key at: https://opencode.ai/auth",
          ].join("\n"),
          choiceId: "opencode-go",
          choiceLabel: "OpenCode Go catalog",
        }),
      ],
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      augmentModelCatalog: (ctx: ProviderAugmentModelCatalogContext) => {
        const glm51 = buildOpencodeGoForwardCompatCatalogEntry({
          entries: ctx.entries,
          modelId: OPENCODE_GO_GLM_5_1_MODEL_ID,
          templateIds: [OPENCODE_GO_GLM_5_MODEL_ID],
          name: "GLM 5.1",
        });
        return glm51 ? [glm51] : [];
      },
      isModernModelRef: () => true,
    });
  },
});
