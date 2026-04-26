import {
  createDefaultModelPresetAppliers,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const PORTKEY_BASE_URL = "https://api.portkey.ai/v1";
export const PORTKEY_DEFAULT_MODEL_ID = "claude-opus-4-6";
export const PORTKEY_DEFAULT_MODEL_REF = `portkey/${PORTKEY_DEFAULT_MODEL_ID}`;
const PORTKEY_DEFAULT_CONTEXT_WINDOW = 128_000;
const PORTKEY_DEFAULT_MAX_TOKENS = 8_192;
const PORTKEY_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildPortkeyModelDefinition(): ModelDefinitionConfig {
  return {
    id: PORTKEY_DEFAULT_MODEL_ID,
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: PORTKEY_DEFAULT_COST,
    contextWindow: PORTKEY_DEFAULT_CONTEXT_WINDOW,
    maxTokens: PORTKEY_DEFAULT_MAX_TOKENS,
  };
}

const portkeyPresetAppliers = createDefaultModelPresetAppliers({
  primaryModelRef: PORTKEY_DEFAULT_MODEL_REF,
  resolveParams: (cfg: OpenClawConfig) => {
    const existingProvider = cfg.models?.providers?.portkey as { baseUrl?: unknown } | undefined;
    const resolvedBaseUrl =
      typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";

    return {
      providerId: "portkey",
      api: "openai-completions" as const,
      baseUrl: resolvedBaseUrl || PORTKEY_BASE_URL,
      defaultModel: buildPortkeyModelDefinition(),
      defaultModelId: PORTKEY_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: PORTKEY_DEFAULT_MODEL_REF, alias: "Portkey" }],
    };
  },
});

export function applyPortkeyProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return portkeyPresetAppliers.applyProviderConfig(cfg);
}

export function applyPortkeyConfig(cfg: OpenClawConfig): OpenClawConfig {
  return portkeyPresetAppliers.applyConfig(cfg);
}
