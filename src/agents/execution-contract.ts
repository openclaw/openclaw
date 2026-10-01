/**
 * Resolves strict agentic execution contracts for provider/model pairs.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentExecutionContract, resolveSessionAgentIds } from "./agent-scope.js";

/** Match bare model names consistently with provider/name and provider:name references. */
export function stripProviderPrefix(modelId: string): string {
  const normalizedModelId = modelId.trim();
  const match = /^([^/:]+)[/:](.+)$/.exec(normalizedModelId);
  return (match?.[2] ?? normalizedModelId).toLowerCase();
}

// Include GPT-5o and version/preview suffixes without matching a later numbered family.
const STRICT_AGENTIC_MODEL_ID_PATTERN = /^gpt-5(?:[.o-]|$)/i;

/** The embedded mock provider exercises the same incomplete-turn recovery as OpenAI. */
export function isStrictAgenticSupportedProviderModel(params: {
  provider?: string | null;
  modelId?: string | null;
}): boolean {
  const provider = normalizeLowercaseStringOrEmpty(params.provider ?? "");
  if (provider !== "openai" && provider !== "mock-openai") {
    return false;
  }
  const modelId = typeof params.modelId === "string" ? params.modelId : "";
  const bareModelId = stripProviderPrefix(modelId);
  return STRICT_AGENTIC_MODEL_ID_PATTERN.test(bareModelId);
}

/** Unsupported routes remain inert; supported routes honor an explicit default opt-out. */
export function isStrictAgenticExecutionContractActive(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string | null;
  provider?: string | null;
  modelId?: string | null;
}): boolean {
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId ?? undefined,
  });
  const explicit = resolveAgentExecutionContract(params.config, sessionAgentId);
  const supported = isStrictAgenticSupportedProviderModel({
    provider: params.provider,
    modelId: params.modelId,
  });
  return supported && explicit !== "default";
}
