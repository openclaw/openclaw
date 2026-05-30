import { formatThinkingLevels } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSubagentSpawnModelSelection } from "./model-selection.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

export function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const provider = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);
    return { provider, model };
  }
  const provider = undefined;
  const model = trimmed;
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

// When a subagent's configured default is a subscription-backed CLI provider
// (currently openai-codex), an explicit `model` override that resolves to the
// raw direct API route (`openai/*` or the bare `gpt` alias) would silently
// bypass the configured subscription and hit the direct API instead.  Reject
// these calls early so the caller sees a clear actionable error rather than a
// downstream auth/quota failure.
export function detectAmbiguousSubagentModelOverride(params: {
  modelOverride?: string;
  configuredDefault?: string;
  resolvedOverride?: string;
}): { status: "ok" } | { status: "forbidden"; error: string } {
  const explicit = params.modelOverride?.trim();
  if (!explicit) {
    return { status: "ok" };
  }
  const { provider: defaultProvider, model: defaultModel } = splitModelRef(
    params.configuredDefault,
  );
  if (defaultProvider?.toLowerCase() !== "openai-codex") {
    return { status: "ok" };
  }
  const resolved = params.resolvedOverride?.trim() || explicit;
  const { provider: resolvedProvider, model: resolvedModel } = splitModelRef(resolved);
  const isDirectOpenaiProvider = resolvedProvider?.toLowerCase() === "openai";
  const isBareAmbiguousGpt =
    !resolvedProvider && (resolvedModel ?? "").toLowerCase() === "gpt";
  if (!isDirectOpenaiProvider && !isBareAmbiguousGpt) {
    return { status: "ok" };
  }
  const recommendedModel = defaultModel ?? "gpt-5.5";
  const recommended = `openai-codex/${recommendedModel}`;
  return {
    status: "forbidden",
    error:
      `Refusing to spawn subagent with model "${explicit}": that override resolves to a direct OpenAI API route, ` +
      `but the configured subagent default is subscription-backed (${params.configuredDefault ?? recommended}). ` +
      `Omit the model parameter to use the configured default, or pass model="${recommended}" explicitly.`,
  };
}

export function resolveConfiguredSubagentRunTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  runTimeoutSeconds?: number;
}) {
  const cfgSubagentTimeout =
    typeof params.cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
    Number.isFinite(params.cfg.agents.defaults.subagents.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.cfg.agents.defaults.subagents.runTimeoutSeconds))
      : 0;
  return typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
    ? Math.max(0, Math.floor(params.runTimeoutSeconds))
    : cfgSubagentTimeout;
}

export function resolveSubagentModelAndThinkingPlan(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  targetAgentConfig?: unknown;
  modelOverride?: string;
  thinkingOverrideRaw?: string;
}) {
  const resolvedModel = resolveSubagentSpawnModelSelection({
    cfg: params.cfg,
    agentId: params.targetAgentId,
    modelOverride: params.modelOverride,
  });

  const trimmedOverride = params.modelOverride?.trim();
  if (trimmedOverride) {
    const configuredDefault = resolveSubagentSpawnModelSelection({
      cfg: params.cfg,
      agentId: params.targetAgentId,
      modelOverride: undefined,
    });
    const guardrail = detectAmbiguousSubagentModelOverride({
      modelOverride: trimmedOverride,
      configuredDefault,
      resolvedOverride: resolvedModel,
    });
    if (guardrail.status === "forbidden") {
      return {
        status: "forbidden" as const,
        resolvedModel,
        error: guardrail.error,
      };
    }
  }

  const thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    targetAgentConfig: params.targetAgentConfig,
    thinkingOverrideRaw: params.thinkingOverrideRaw,
  });
  if (thinkingPlan.status === "error") {
    const { provider, model } = splitModelRef(resolvedModel);
    const hint = formatThinkingLevels(provider, model);
    return {
      status: "error" as const,
      resolvedModel,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${hint}.`,
    };
  }

  return {
    status: "ok" as const,
    resolvedModel,
    modelApplied: Boolean(resolvedModel),
    thinkingOverride: thinkingPlan.thinkingOverride,
    initialSessionPatch: {
      ...(resolvedModel
        ? {
            model: resolvedModel,
            modelOverrideSource: params.modelOverride?.trim() ? "user" : "auto",
          }
        : {}),
      ...thinkingPlan.initialSessionPatch,
    },
  };
}
