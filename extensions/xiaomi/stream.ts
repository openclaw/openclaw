import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createDeepSeekV4OpenAICompatibleThinkingWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

const MIMO_THINKING_MODEL_IDS = new Set(["mimo-v2.5", "mimo-v2.5-pro"]);

function isMiMoThinkingModelRef(model: { provider?: string; id?: unknown }): boolean {
  const provider = model.provider;
  const id = typeof model.id === "string" ? model.id : "";
  return (provider === "xiaomi" || provider === "xiaomi-coding") && MIMO_THINKING_MODEL_IDS.has(id.toLowerCase());
}

export function createMiMoThinkingWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  return createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: isMiMoThinkingModelRef,
  });
}
