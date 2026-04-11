import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveAgentExecutionContract, resolveSessionAgentIds } from "./agent-scope.js";

/**
 * Supported provider + model combinations where strict-agentic is the intended
 * runtime contract. Kept as a narrow helper so both the execution-contract
 * resolver and the `update_plan` auto-enable gate converge on the same
 * definition of "GPT-5-family openai/openai-codex run".
 */
function isStrictAgenticSupportedProviderModel(params: {
  provider?: string | null;
  modelId?: string | null;
}): boolean {
  const provider = normalizeLowercaseStringOrEmpty(params.provider ?? "");
  if (provider !== "openai" && provider !== "openai-codex") {
    return false;
  }
  return /^gpt-5(?:[.-]|$)/i.test(params.modelId?.trim() ?? "");
}

/**
 * Returns the effective execution contract for an embedded Pi run.
 *
 * - Explicit `"strict-agentic"` in config (defaults or per-agent override) ⇒ `"strict-agentic"`.
 * - Explicit `"default"` in config ⇒ `"default"` (opt-out honored).
 * - Unspecified + supported provider/model (openai/openai-codex, gpt-5-family) ⇒
 *   `"strict-agentic"` so the no-stall completion-gate criterion applies to
 *   out-of-the-box GPT-5 runs without requiring every user to set the flag.
 * - Otherwise ⇒ `"default"`.
 *
 * This means explicit opt-out still works, but the gate criterion
 * "GPT-5.4 no longer stalls after planning" now covers unconfigured
 * installations, not only users who opted in manually.
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
  // strict-agentic is a GPT-5-family openai/openai-codex runtime contract
  // regardless of whether it was set explicitly or auto-activated. On an
  // unsupported provider/model pair the contract is inert either way, so
  // the effective value collapses to "default".
  const supported = isStrictAgenticSupportedProviderModel({
    provider: params.provider,
    modelId: params.modelId,
  });
  if (!supported) {
    return "default";
  }
  if (explicit === "default") {
    return "default";
  }
  // Explicit strict-agentic OR unspecified-but-supported → strict-agentic.
  return "strict-agentic";
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
