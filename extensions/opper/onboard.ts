import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import {
  getStaticOpperModelCatalog,
  OPPER_BASE_URL,
  OPPER_DEFAULT_MODEL_REF,
  OPPER_PROVIDER_ID,
} from "./provider-models.js";

export { OPPER_DEFAULT_MODEL_REF };

export const { applyConfig: applyOpperConfig } = createProviderConnectionPresetAppliers<[]>({
  primaryModelRef: OPPER_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: OPPER_PROVIDER_ID,
    api: "openai-completions",
    baseUrl: OPPER_BASE_URL,
    catalogModels: getStaticOpperModelCatalog,
    aliases: [{ modelRef: OPPER_DEFAULT_MODEL_REF, alias: "Opper" }],
  }),
});
