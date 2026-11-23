import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export function buildBf16Provider() {
  return buildManifestModelProviderConfig({
    providerId: "bf16",
    catalog: manifest.modelCatalog.providers.bf16,
  });
}

const BF16_DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash-uncensored";
export const BF16_DEFAULT_MODEL_REF = `bf16/${BF16_DEFAULT_MODEL_ID}` as const;
