import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import {
  getStaticRequestyModelCatalog,
  REQUESTY_BASE_URL,
  REQUESTY_DEFAULT_MODEL_REF,
  REQUESTY_PROVIDER_ID,
} from "./provider-models.js";

export { REQUESTY_DEFAULT_MODEL_REF };

export const { applyConfig: applyRequestyConfig } = createProviderConnectionPresetAppliers<[]>({
  primaryModelRef: REQUESTY_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: REQUESTY_PROVIDER_ID,
    api: "openai-completions",
    baseUrl: REQUESTY_BASE_URL,
    catalogModels: getStaticRequestyModelCatalog,
    aliases: [{ modelRef: REQUESTY_DEFAULT_MODEL_REF, alias: "Requesty" }],
  }),
});
