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
  getBlinkGatewayBaseUrl,
} from "../providers/blink-shared.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export { BLINK_DEFAULT_MODEL_ID };

export function buildBlinkProvider(agentId?: string): ProviderConfig {
  const headers: Record<string, string> = {};

  // Inject agent identity header for per-agent Tinybird usage tracking.
  // agentId comes from BLINK_AGENT_ID env var, separate from the API key.
  const resolvedAgentId = agentId ?? process.env.BLINK_AGENT_ID;
  if (resolvedAgentId && resolvedAgentId.trim()) {
    headers["x-blink-agent-id"] = resolvedAgentId.trim();
  }

  return {
    baseUrl: getBlinkGatewayBaseUrl(),
    api: "openai-completions",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    models: BLINK_MODEL_CATALOG.map((model) => ({
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
