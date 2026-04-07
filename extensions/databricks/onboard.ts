import { type OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";

export const DATABRICKS_DEFAULT_MODEL_REF = "databricks/databricks-meta-llama-3-1-70b-instruct";

export function applyDatabricksConfig(cfg: OpenClawConfig): OpenClawConfig {
  return cfg;
}
