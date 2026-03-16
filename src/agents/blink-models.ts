/**
 * buildBlinkProvider — ProviderConfig for the Blink AI Gateway.
 *
 * Follows the exact same pattern as buildKilocodeProvider().
 * Uses `api: "openai-completions"` because blink-apis serves
 * an OpenAI-compatible `/api/v1/ai/chat/completions` endpoint.
 *
 * The `x-blink-agent-id` header is included when BLINK_AGENT_ID env var is
 * set (always present in Blink Claw Fly.io containers). It lets blink-apis
 * track per-agent LLM usage in Tinybird. The API key itself is workspace-
 * scoped; agent identity is a separate concern sent in this header.
 */

import type { OpenClawConfig } from "../config/config.js";
import {
  BLINK_DEFAULT_COST,
  BLINK_DEFAULT_MODEL_ID,
  BLINK_MODEL_CATALOG,
  BLINK_MODEL_CATALOG_STATIC,
  fetchBlinkModelCatalog,
  getBlinkGatewayBaseUrl,
} from "../providers/blink-shared.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export { BLINK_DEFAULT_MODEL_ID };

function buildProviderConfig(agentId?: string, catalog = BLINK_MODEL_CATALOG): ProviderConfig {
  const headers: Record<string, string> = {};
  const resolvedAgentId = agentId ?? process.env.BLINK_AGENT_ID;
  if (resolvedAgentId?.trim()) {
    headers["x-blink-agent-id"] = resolvedAgentId.trim();
  }

  return {
    baseUrl: getBlinkGatewayBaseUrl(),
    api: "openai-completions",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    models: catalog.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: BLINK_DEFAULT_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  };
}

/**
 * Build the Blink provider config.
 * Fetches the full language model catalog from the gateway; falls back to
 * the static list if the request fails (e.g. network unavailable at startup).
 */
export async function buildBlinkProvider(agentId?: string): Promise<ProviderConfig> {
  const catalog = await fetchBlinkModelCatalog().catch(() => BLINK_MODEL_CATALOG_STATIC);
  return buildProviderConfig(agentId, catalog);
}

/** Synchronous variant — uses whatever catalog is currently cached (static on first call). */
export function buildBlinkProviderSync(agentId?: string): ProviderConfig {
  return buildProviderConfig(agentId);
}
