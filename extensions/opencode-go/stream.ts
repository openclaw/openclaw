import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";

function isOpencodeGoDeepSeekV4ModelId(modelId: unknown): boolean {
  return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}

function isDisabledDeepSeekV4ThinkingLevel(thinkingLevel: unknown): boolean {
  const normalized = typeof thinkingLevel === "string" ? thinkingLevel.toLowerCase() : "";
  return normalized === "off" || normalized === "none";
}

export function createOpencodeGoDeepSeekV4Wrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) return undefined;
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (!(model.provider === "opencode-go" && isOpencodeGoDeepSeekV4ModelId(model.id))) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      // Handle disabled thinking
      if (isDisabledDeepSeekV4ThinkingLevel(thinkingLevel)) {
        payload.thinking = { type: "disabled" };
        delete payload.reasoning_effort;
        delete payload.reasoning;
        if (Array.isArray(payload.messages)) {
          for (const msg of payload.messages) {
            if (msg && typeof msg === "object") {
              delete (msg as Record<string, unknown>).reasoning_content;
            }
          }
        }
        return;
      }

      // Use model.thinkingLevelMap if available, otherwise fall back to hardcoded mapping
      const map = (model as unknown as Record<string, unknown>).thinkingLevelMap as
        | Record<string, string | null>
        | undefined;
      const mappedEffort =
        typeof map === "object" && map !== null ? map[String(thinkingLevel)] : undefined;
      const reasoningEffort =
        typeof mappedEffort === "string"
          ? mappedEffort
          : thinkingLevel === "xhigh" || thinkingLevel === "max"
            ? "max"
            : "high";

      payload.thinking = { type: "enabled" };
      payload.reasoning_effort = reasoningEffort;

      // Backfill reasoning_content on assistant messages
      if (Array.isArray(payload.messages)) {
        for (const message of payload.messages) {
          if (
            message &&
            typeof message === "object" &&
            (message as Record<string, unknown>).role === "assistant"
          ) {
            const record = message as Record<string, unknown>;
            if (!("reasoning_content" in record)) {
              record.reasoning_content = "";
            }
          }
        }
      }
    });
  };
}
