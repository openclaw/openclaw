import {
  applyProviderConnectionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  getDatabricksDefaultModelRef,
  getDatabricksModelCatalog,
  resolveDatabricksBaseUrl,
} from "./models.js";

export function applyDatabricksConnectionConfig(cfg: OpenClawConfig, host: string): OpenClawConfig {
  const baseUrl = resolveDatabricksBaseUrl(host, cfg.models?.providers?.databricks?.baseUrl);
  if (!baseUrl) {
    throw new Error("Invalid Databricks workspace host. Expected an HTTPS workspace URL.");
  }
  const defaultModelRef = getDatabricksDefaultModelRef(baseUrl);
  return applyProviderConnectionConfig(cfg, {
    providerId: "databricks",
    api: "openai-completions",
    baseUrl,
    catalogModels: () => getDatabricksModelCatalog(baseUrl),
    aliases: [{ modelRef: defaultModelRef, alias: "Databricks" }],
    primaryModelRef: defaultModelRef,
  });
}
