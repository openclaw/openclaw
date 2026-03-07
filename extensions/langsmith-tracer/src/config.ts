import { Client } from "langsmith";

/**
 * Configuration for the LangSmith tracer extension.
 *
 * All values can be set via env vars (standard LangSmith convention) or via
 * the openclaw.yml plugin config block:
 *
 *   plugins:
 *     entries:
 *       langsmith-tracer:
 *         enabled: true
 *         config:
 *           project: "my-project"
 *
 * Env vars take precedence over plugin config.
 */
export type LangSmithConfig = {
  apiKey: string;
  project: string;
  endpoint: string;
};

/**
 * Returns true when the LANGSMITH_API_KEY env var is set (or apiKey provided
 * in plugin config). When false the plugin registers no-op hooks.
 */
export function isEnabled(pluginConfig?: Record<string, unknown>): boolean {
  return Boolean(process.env.LANGSMITH_API_KEY ?? (pluginConfig?.["apiKey"] as string | undefined));
}

/**
 * Resolves the effective LangSmith config from env + plugin config.
 * Plugin config keys: apiKey, project, endpoint.
 */
export function resolveConfig(pluginConfig?: Record<string, unknown>): LangSmithConfig {
  const apiKey =
    process.env.LANGSMITH_API_KEY ?? (pluginConfig?.["apiKey"] as string | undefined) ?? "";
  const project =
    process.env.LANGSMITH_PROJECT ??
    (pluginConfig?.["project"] as string | undefined) ??
    "openclaw-agent-runs";
  const endpoint =
    process.env.LANGSMITH_ENDPOINT ??
    (pluginConfig?.["endpoint"] as string | undefined) ??
    "https://api.smith.langchain.com";

  return { apiKey, project, endpoint };
}

/**
 * Creates an authenticated LangSmith Client.
 * Call only after isEnabled() returns true.
 */
export function buildClient(cfg: LangSmithConfig): Client {
  return new Client({
    apiKey: cfg.apiKey,
    apiUrl: cfg.endpoint,
  });
}
