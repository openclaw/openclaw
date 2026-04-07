import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildDatabricksModelDefinition, DATABRICKS_BASE_URL, DATABRICKS_MODEL_CATALOG } from "./api.js";

export const DATABRICKS_DEFAULT_MODEL_REF = "databricks/databricks-meta-llama-3-1-70b-instruct";

const databricksPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: DATABRICKS_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "databricks",
    api: "openai-completions",
    baseUrl: DATABRICKS_BASE_URL,
    catalogModels: DATABRICKS_MODEL_CATALOG.map(buildDatabricksModelDefinition),
    aliases: [{ modelRef: DATABRICKS_DEFAULT_MODEL_REF, alias: "Databricks Serving" }],
  }),
});

export function applyDatabricksConfig(cfg: OpenClawConfig): OpenClawConfig {
  return databricksPresetAppliers.applyConfig(cfg);
}
