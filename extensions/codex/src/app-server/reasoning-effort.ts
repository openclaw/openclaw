import { selectSupportedReasoningEffort } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";

const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type CodexEnabledReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
type CodexReasoningEffort = CodexEnabledReasoningEffort | "none" | "ultra";

const LEGACY_PRO_REASONING_EFFORTS = ["medium", "high", "xhigh"] as const;
const LEGACY_PRO_MODEL_ID_RE = /^gpt-5\.[45]-pro$/u;
const MODERN_GPT_5_MODEL_ID_RE = /^gpt-5\.(?:[3-9]|[1-9]\d)(?:$|-)/u;

/** Read reasoning metadata after the Codex app-server route has been selected. */
export function readCodexSupportedReasoningEfforts(
  compat: EmbeddedRunAttemptParams["model"]["compat"],
): string[] | undefined {
  return compat && "supportedReasoningEfforts" in compat
    ? compat.supportedReasoningEfforts
    : undefined;
}

export function resolveCodexAppServerReasoningEffort(params: {
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"];
  modelId: string;
  supportedReasoningEfforts?: readonly string[];
}): CodexReasoningEffort | null {
  // Ultra is a runtime mode, not an API effort tier. Codex owns its inference
  // budget and proactive delegation; route metadata must not erase the runtime mode.
  if (params.thinkLevel === "ultra") {
    return "ultra";
  }
  if (params.thinkLevel === "off") {
    return params.supportedReasoningEfforts?.includes("none") ? "none" : null;
  }
  if (params.thinkLevel === "adaptive") {
    return null;
  }
  const modelId = params.modelId.trim().toLowerCase();
  // Preserve compatibility for deprecated Pro catalog rows that predate effort
  // metadata. New model capabilities must come from the provider catalog.
  const supportedReasoningEfforts =
    params.supportedReasoningEfforts ??
    (LEGACY_PRO_MODEL_ID_RE.test(modelId) ? LEGACY_PRO_REASONING_EFFORTS : undefined);
  if (supportedReasoningEfforts) {
    return (
      selectSupportedReasoningEffort({
        requested: params.thinkLevel,
        supportedEfforts: supportedReasoningEfforts.map((effort) => effort.trim().toLowerCase()),
        effortOrder: CODEX_REASONING_EFFORTS,
      }) ?? null
    );
  }
  if (params.thinkLevel === "minimal" && MODERN_GPT_5_MODEL_ID_RE.test(modelId)) {
    return "low";
  }
  return params.thinkLevel === "max" ? null : params.thinkLevel;
}
