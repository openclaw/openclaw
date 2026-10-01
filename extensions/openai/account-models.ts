import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { OPENAI_PROVIDER_MODERN_MODEL_IDS } from "./model-route-contract.js";

// Zero rates are unknown pricing to usage reporting, not a free model.
export const OPENAI_UNKNOWN_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} satisfies ModelDefinitionConfig["cost"];

// Plain /v1/models rows carry only ids (#114258), so admit current GPT/o-series
// chat families and drop media, realtime, search, legacy, snapshot and experiment ids.
// Listed chat-latest, codex and cyber ids can 404 on /v1/responses for API keys.
const OPENAI_CHAT_FAMILY_MODEL_ID_PATTERN =
  /^(?:gpt-(?:4o|4\.1|[5-9](?:\.\d+)?|[1-9]\d(?:\.\d+)?)|o[1-9])(?:-[a-z0-9.]+)*$/;
const OPENAI_UNADMITTED_MODEL_ID_PATTERN =
  /(?:^|-)(?:audio|realtime|live|transcribe|diarize|tts|image|search|deep-research|instruct|translate|exp|preview|alpha|beta|treatment|chat-latest|codex|cyber|\d{4}(?:-\d{2}-\d{2})?)(?:-|$)/;

/** Conservative rows for account-listed chat models that no catalog row describes. */
export function buildOpenAIAccountOnlyModels(params: {
  discoveredIds: ReadonlySet<string>;
  catalogModels: readonly ModelDefinitionConfig[];
  baseUrl: string;
}): ModelDefinitionConfig[] {
  const knownIds = new Set<string>([
    ...OPENAI_PROVIDER_MODERN_MODEL_IDS,
    ...params.catalogModels.map((model) => model.id),
  ]);
  return [...params.discoveredIds]
    .filter(
      (id) =>
        !knownIds.has(id) &&
        OPENAI_CHAT_FAMILY_MODEL_ID_PATTERN.test(id) &&
        !OPENAI_UNADMITTED_MODEL_ID_PATTERN.test(id),
    )
    .toSorted()
    .map((id) => ({
      id,
      name: id,
      api: "openai-responses",
      baseUrl: params.baseUrl,
      // GPT-5+ and o-series reason; GPT-4o/4.1 do not.
      reasoning: /^(?:gpt-(?:[5-9]|\d{2})|o\d)/.test(id),
      input: ["text"],
      cost: OPENAI_UNKNOWN_MODEL_COST,
      contextWindow: 128_000,
      maxTokens: 16_384,
    }));
}
