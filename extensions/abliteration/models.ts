import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export function buildAbliterationProvider() {
  return buildManifestModelProviderConfig({
    providerId: "abliteration",
    catalog: manifest.modelCatalog.providers.abliteration,
  });
}

const ABLITERATION_DEFAULT_MODEL_ID = "abliterated-model-large-flash";
export const ABLITERATION_DEFAULT_MODEL_REF =
  `abliteration/${ABLITERATION_DEFAULT_MODEL_ID}` as const;
