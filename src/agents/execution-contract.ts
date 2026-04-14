import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveAgentExecutionContract, resolveSessionAgentIds } from "./agent-scope.js";

/**
 * Strip any leading `provider/` or `provider:` prefix from a model id so the
 * bare-name regex matching below works against `openai/gpt-5.4` and
 * `openai:gpt-5.4` the same way it does against `gpt-5.4`. Returns the bare
 * model id lowercased for comparison.
 *
 * Without this, auto-activation silently failed on prefixed model ids — a
 * user who configured `model: "openai/gpt-5.4"` in their agent config would
 * get the pre-PR-H looser default behavior because the regex only matched
 * bare names. The adversarial review in #64227 flagged this as a quality
 * gap on completion-gate criterion 1.
 */
function stripProviderPrefix(modelId: string): string {
  const normalizedModelId = modelId.trim();
  const match = /^([^/:]+)[/:](.+)$/.exec(normalizedModelId);
  return (match?.[2] ?? normalizedModelId).toLowerCase();
}

/**
 * Regex that matches the full set of GPT-5 variants the strict-agentic
 * contract should auto-activate for. Intentionally permissive: every
 * model id in the gpt-5 family should opt in by default, not just the
 * canonical `gpt-5.4`.
 *
 * Covers:
 * - `gpt-5`, `gpt-5o`, `gpt-5o-mini` (no separator after `5`)
 * - `gpt-5.4`, `gpt-5.4-alt`, `gpt-5.0` (dot separator)
 * - `gpt-5-preview`, `gpt-5-turbo`, `gpt-5-2025-03` (dash separator)
 *
 * Does NOT cover `gpt-4.5`, `gpt-6`, or any non-gpt-5 family member.
 */
const STRICT_AGENTIC_MODEL_ID_PATTERN = /^gpt-5(?:[.o-]|$)/i;

/**
 * Supported provider + model combinations where strict-agentic is the intended
 * runtime contract. Kept as a narrow helper so both the execution-contract
 * resolver and the `update_plan` auto-enable gate converge on the same
 * definition of "GPT-5-family openai/openai-codex run". The embedded
 * `mock-openai` QA lane intentionally piggybacks on that contract so repo QA
 * can exercise the same incomplete-turn recovery rules end to end.
 */
export function isStrictAgenticSupportedProviderModel(params: {
  provider?: string | null;
  modelId?: string | null;
}): boolean {
  const provider = normalizeLowercaseStringOrEmpty(params.provider ?? "");
  if (provider !== "openai" && provider !== "openai-codex" && provider !== "mock-openai") {
    return false;
  }
  const modelId = typeof params.modelId === "string" ? params.modelId : "";
  const bareModelId = stripProviderPrefix(modelId);
  return STRICT_AGENTIC_MODEL_ID_PATTERN.test(bareModelId);
}

/**
 * Returns the effective execution contract for an embedded Pi run.
 *
 * The behavior matrix is:
 *
 * - Explicit `"strict-agentic"` in config (defaults or per-agent override)
 *   ⇒ `"strict-agentic"` regardless of provider. This lets non-OpenAI
 *   providers (LM Studio, Ollama, etc.) opt in to the planning-only retry
 *   guard and completion-gate behavior.
 * - Explicit `"default"` in config ⇒ `"default"` (opt-out honored).
 * - Supported provider/model (GPT-5-family on openai/openai-codex) +
 *   unspecified ⇒ `"strict-agentic"` so out-of-the-box GPT-5 runs get
 *   the no-stall completion-gate without requiring manual opt-in.
 * - Unsupported provider/model + unspecified ⇒ `"default"`.
 *
 * This means explicit opt-in/out always wins, auto-activation covers
 * unconfigured GPT-5 installations, and other providers can opt in
 * when the operator knows their model benefits from the retry guard.
 */
export function resolveEffectiveExecutionContract(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string | null;
  provider?: string | null;
  modelId?: string | null;
}): "default" | "strict-agentic" {
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId ?? undefined,
  });
  const explicit = resolveAgentExecutionContract(params.config, sessionAgentId);
  // Explicit opt-in is honored regardless of provider — this lets non-OpenAI
  // providers (LM Studio, Ollama, etc.) benefit from the planning-only retry
  // guard when the operator deliberately configures strict-agentic.
  if (explicit === "strict-agentic") {
    return "strict-agentic";
  }
  // Explicit opt-out is always honored.
  if (explicit === "default") {
    return "default";
  }
  // Auto-activate for supported GPT-5-family provider/model pairs when the
  // config is unspecified, so out-of-the-box GPT-5 runs get the no-stall
  // completion-gate without requiring manual opt-in.
  const supported = isStrictAgenticSupportedProviderModel({
    provider: params.provider,
    modelId: params.modelId,
  });
  return supported ? "strict-agentic" : "default";
}

export function isStrictAgenticExecutionContractActive(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string | null;
  provider?: string | null;
  modelId?: string | null;
}): boolean {
  return resolveEffectiveExecutionContract(params) === "strict-agentic";
}
