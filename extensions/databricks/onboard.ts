import {
  applyProviderConnectionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  DATABRICKS_DEFAULT_MODEL_REF,
  DATABRICKS_MODEL_CATALOG,
  resolveDatabricksBaseUrl,
} from "./models.js";

export function applyDatabricksConnectionConfig(cfg: OpenClawConfig, host: string): OpenClawConfig {
  const baseUrl = resolveDatabricksBaseUrl(host);
  if (!baseUrl) {
    throw new Error("Invalid Databricks workspace host. Expected an HTTPS workspace URL.");
  }
  return applyProviderConnectionConfig(cfg, {
    providerId: "databricks",
    api: "openai-completions",
    baseUrl,
    catalogModels: () => structuredClone(DATABRICKS_MODEL_CATALOG),
    aliases: [{ modelRef: DATABRICKS_DEFAULT_MODEL_REF, alias: "Databricks" }],
    primaryModelRef: DATABRICKS_DEFAULT_MODEL_REF,
  });
}
