import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createDeepSeekV4OpenAICompatibleThinkingWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

const MIMO_THINKING_MODEL_IDS = new Set(["mimo-v2.5", "mimo-v2.5-pro"]);

function isMiMoThinkingModelRef(model: { provider?: string; id?: unknown }): boolean {
  return (
    (model.provider === "xiaomi" || model.provider === "xiaomi-coding") &&
    typeof model.id === "string" &&
    MIMO_THINKING_MODEL_IDS.has(model.id.toLowerCase());
  );
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
