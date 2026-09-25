import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty as normalizeModelId } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  OPENAI_GPT_53_CODEX_SPARK_MODEL_ID,
  OPENAI_GPT_54_MINI_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID,
  OPENAI_GPT_54_NANO_MODEL_ID,
  OPENAI_GPT_54_PRO_MODEL_ID,
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID,
  OPENAI_GPT_56_MODEL_ID,
  OPENAI_GPT_6_ASTRA_MODEL_ID,
  OPENAI_GPT_6_MODEL_IDS,
  resolveOpenAICodexReasoningEfforts,
} from "./model-route-contract.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

type OpenAIThinkingCompat = ProviderDefaultThinkingPolicyContext["compat"];
type OpenAIThinkingApi = ProviderDefaultThinkingPolicyContext["api"];

const OPENAI_THINKING_BASE_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

const OPENAI_THINKING_LEVEL_ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
type OpenAIThinkingLevelId = (typeof OPENAI_THINKING_LEVEL_ORDER)[number];

const OPENAI_UNIFIED_XHIGH_MODEL_IDS = [
  OPENAI_GPT_56_MODEL_ID,
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID,
  OPENAI_GPT_54_PRO_MODEL_ID,
  OPENAI_GPT_53_CODEX_SPARK_MODEL_ID,
  OPENAI_GPT_54_MINI_MODEL_ID,
  OPENAI_GPT_54_NANO_MODEL_ID,
] as const;

function normalizeCodexReasoningEffort(value: string): OpenAIThinkingLevelId | undefined {
  const normalized = normalizeModelId(value);
  if (normalized === "none") {
    return "off";
  }
  return OPENAI_THINKING_LEVEL_ORDER.find((level) => level === normalized);
}

function buildCodexLevels(efforts: readonly string[]): ProviderThinkingProfile["levels"] {
  // Omitting effort uses the model default; only an advertised none/off disables reasoning.
  const supported = new Set<OpenAIThinkingLevelId>();
  for (const effort of efforts) {
    const level = normalizeCodexReasoningEffort(effort);
    if (level) {
      supported.add(level);
    }
  }
  return OPENAI_THINKING_LEVEL_ORDER.filter((level) => supported.has(level)).map((id) => ({ id }));
}

export function resolveUnifiedOpenAIThinkingProfile(
  rawModelId: string,
  rawAgentRuntime?: string | null,
  compat?: OpenAIThinkingCompat,
  api?: OpenAIThinkingApi,
  thinkingLevelMap?: ProviderDefaultThinkingPolicyContext["thinkingLevelMap"],
): ProviderThinkingProfile {
  const modelId = normalizeModelId(rawModelId);
  const agentRuntime = normalizeModelId(rawAgentRuntime ?? "");
  const codexEfforts = compat?.supportedReasoningEfforts?.map(normalizeModelId);
  if (compat?.supportsReasoningEffort === false || codexEfforts?.length === 0) {
    const hostRuntime = !agentRuntime || agentRuntime === "auto" || agentRuntime === "openclaw";
    const binaryThinking =
      api === "openai-completions" &&
      hostRuntime &&
      ["qwen", "qwen-chat-template", "zai", "deepseek", "together"].includes(
        compat?.thinkingFormat ?? "",
      );
    return { levels: binaryThinking ? OPENAI_THINKING_BASE_LEVELS : [] };
  }
  const canSynthesizeUltra = thinkingLevelMap?.max !== null;
  if (OPENAI_GPT_6_MODEL_IDS.some((id) => id === modelId)) {
    const fallbackEfforts =
      manifest.modelCatalog.providers.openai.models.find((model) => model.id === modelId)?.compat
        ?.supportedReasoningEfforts ?? [];
    // Native Codex owns its effort picker even when the subscription API accepts none.
    const efforts =
      codexEfforts ??
      (agentRuntime === "codex"
        ? fallbackEfforts.filter((effort) => effort !== "none")
        : fallbackEfforts);
    // Ultra is runtime orchestration; the Platform's scalar effort list stops at Max.
    // Preserve narrower account capabilities while exposing the supported runtime mode.
    const supportsUltra =
      ["openclaw", "codex", "auto"].includes(agentRuntime) &&
      efforts.includes("max") &&
      (agentRuntime === "codex"
        ? modelId === OPENAI_GPT_6_ASTRA_MODEL_ID || efforts.includes("ultra")
        : canSynthesizeUltra);
    const defaultLevel = efforts.includes("medium")
      ? "medium"
      : efforts.includes("low")
        ? "low"
        : undefined;
    return {
      levels: buildCodexLevels(supportsUltra ? [...efforts, "ultra"] : efforts),
      ...(defaultLevel ? { defaultLevel } : {}),
    };
  }
  const resolvedCodexEfforts =
    api === undefined || api === "openai-chatgpt-responses"
      ? resolveOpenAICodexReasoningEfforts(modelId, codexEfforts)
      : undefined;
  const knownCodexEfforts = resolveOpenAICodexReasoningEfforts(modelId, undefined);
  const isGpt56Variant = knownCodexEfforts !== undefined;
  const codexSupportsMax = (resolvedCodexEfforts ?? knownCodexEfforts)?.includes("max");
  const supportsMax =
    modelId.startsWith("gpt-5.6") && (agentRuntime !== "codex" || codexSupportsMax);
  const codexSupportsUltra = (resolvedCodexEfforts ?? knownCodexEfforts)?.includes("ultra");
  const supportsXHigh = OPENAI_UNIFIED_XHIGH_MODEL_IDS.some((prefix) => modelId.startsWith(prefix));
  // OpenClaw owns its logical Ultra orchestration. Native Codex capabilities
  // come from native discovery or the selected ChatGPT route's catalog metadata.
  const supportsUltra =
    (modelId === OPENAI_GPT_56_MODEL_ID || isGpt56Variant) &&
    (((agentRuntime === "openclaw" || agentRuntime === "auto") &&
      (canSynthesizeUltra || codexEfforts?.includes("ultra"))) ||
      (agentRuntime === "codex" && codexSupportsUltra));
  const nativeCodexNeedsAccountEffortValidation =
    agentRuntime === "codex" &&
    compat?.supportedReasoningEfforts === undefined &&
    (api === undefined || api === "openai-chatgpt-responses") &&
    !supportsXHigh &&
    !modelId.startsWith("gpt-5.6");
  const defaultLevel = isGpt56Variant ? "medium" : undefined;
  const fallbackLevels: ProviderThinkingProfile["levels"] = [
    ...OPENAI_THINKING_BASE_LEVELS,
    ...(supportsXHigh ? [{ id: "xhigh" as const }] : []),
    ...(supportsMax ? [{ id: "max" as const }] : []),
    ...(supportsUltra ? [{ id: "ultra" as const }] : []),
    ...(nativeCodexNeedsAccountEffortValidation
      ? [{ id: "xhigh" as const }, { id: "max" as const }]
      : []),
  ];
  const levels =
    agentRuntime === "codex" && resolvedCodexEfforts !== undefined
      ? buildCodexLevels(resolvedCodexEfforts)
      : fallbackLevels;
  const supportedDefault = defaultLevel && levels.some((level) => level.id === defaultLevel);
  return {
    levels,
    ...(supportedDefault ? { defaultLevel } : {}),
  };
}
