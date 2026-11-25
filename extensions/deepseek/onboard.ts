import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL_CATALOG } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const DEEPSEEK_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "deepseek")!;

export const { applyConfig: applyDeepSeekConfig } = createProviderConnectionPresetAppliers<[]>({
  primaryModelRef: DEEPSEEK_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "deepseek",
    api: "openai-completions",
    baseUrl: DEEPSEEK_BASE_URL,
    catalogModels: DEEPSEEK_MODEL_CATALOG,
    aliases: [{ modelRef: DEEPSEEK_DEFAULT_MODEL_REF, alias: "DeepSeek" }],
  }),
});
