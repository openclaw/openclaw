import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export function buildNodecodeProvider() {
  return buildManifestModelProviderConfig({
    providerId: "nodecode",
    catalog: manifest.modelCatalog.providers.nodecode,
  });
}

const NODECODE_DEFAULT_MODEL_ID = "nodecode-cyber-v1";
export const NODECODE_DEFAULT_MODEL_REF = `nodecode/${NODECODE_DEFAULT_MODEL_ID}` as const;
