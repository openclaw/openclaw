import {
  applyProviderConnectionConfig,
  type ModelApi,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  DATABRICKS_DEFAULT_MODEL_REF,
  DATABRICKS_MODEL_CATALOG,
  normalizeDatabricksHost,
  resolveDatabricksBaseUrl,
} from "./models.js";

type DatabricksRoute = {
  baseUrl: string;
  api: ModelApi;
  /** True when an operator-configured route for this workspace is kept as is. */
  preserved: boolean;
};

/**
 * A route the operator already configured for this workspace (for example a hand-written
 * /serving-endpoints base URL) stays, with its API shape: its model ids belong to that route.
 * Onboarding only sets the Unity Gateway route for a new or different workspace.
 */
export function resolveDatabricksRoute(cfg: OpenClawConfig, host: string): DatabricksRoute {
  const gatewayBaseUrl = resolveDatabricksBaseUrl(host);
  if (!gatewayBaseUrl) {
    throw new Error("Invalid Databricks workspace host. Expected an HTTPS workspace URL.");
  }
  const existing = cfg.models?.providers?.databricks;
  const configured = existing?.baseUrl?.trim().replace(/\/+$/, "");
  if (configured && normalizeDatabricksHost(configured) === normalizeDatabricksHost(host)) {
    return { baseUrl: configured, api: existing?.api ?? "openai-completions", preserved: true };
  }
  return { baseUrl: gatewayBaseUrl, api: "openai-completions", preserved: false };
}

export function applyDatabricksConnectionConfig(cfg: OpenClawConfig, host: string): OpenClawConfig {
  const route = resolveDatabricksRoute(cfg, host);
  return applyProviderConnectionConfig(cfg, {
    providerId: "databricks",
    api: route.api,
    baseUrl: route.baseUrl,
    // The default model and catalog are Unity Gateway model services; a kept route has its own.
    catalogModels: () => (route.preserved ? [] : structuredClone(DATABRICKS_MODEL_CATALOG)),
    aliases: route.preserved
      ? []
      : [{ modelRef: DATABRICKS_DEFAULT_MODEL_REF, alias: "Databricks" }],
    ...(route.preserved ? {} : { primaryModelRef: DATABRICKS_DEFAULT_MODEL_REF }),
  });
}
