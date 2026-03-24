import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { usesMoonshotThinkingPayloadCompat } from "../provider-capabilities.js";

type MoonshotThinkingType = "enabled" | "disabled";

function normalizeMoonshotThinkingType(value: unknown): MoonshotThinkingType | undefined {
  if (typeof value === "boolean") {
    return value ? "enabled" : "disabled";
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["enabled", "enable", "on", "true"].includes(normalized)) {
      return "enabled";
    }
    if (["disabled", "disable", "off", "false"].includes(normalized)) {
      return "disabled";
    }
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeMoonshotThinkingType((value as Record<string, unknown>).type);
  }
  return undefined;
}

function isMoonshotToolChoiceCompatible(toolChoice: unknown): boolean {
  if (toolChoice == null || toolChoice === "auto" || toolChoice === "none") {
    return true;
  }
  if (typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const typeValue = (toolChoice as Record<string, unknown>).type;
    return typeValue === "auto" || typeValue === "none";
  }
  return false;
}

function isPinnedToolChoice(toolChoice: unknown): boolean {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return false;
  }
  const typeValue = (toolChoice as Record<string, unknown>).type;
  return typeValue === "tool" || typeValue === "function";
}

export function shouldApplySiliconFlowThinkingOffCompat(params: {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkLevel;
}): boolean {
  return (
    params.provider === "siliconflow" &&
    params.thinkingLevel === "off" &&
    params.modelId.startsWith("Pro/")
  );
}

export function shouldApplyMoonshotPayloadCompat(params: {
  provider: string;
  modelId: string;
}): boolean {
  const normalizedProvider = params.provider.trim().toLowerCase();
  const normalizedModelId = params.modelId.trim().toLowerCase();

  if (usesMoonshotThinkingPayloadCompat(normalizedProvider)) {
    return true;
  }

  // Ollama Cloud exposes Kimi variants through OpenAI-compatible model IDs such
  // as `kimi-k2.5:cloud`, but they still need the same payload normalization as
  // native Moonshot endpoints when thinking/tool_choice are enabled together.
  return (
    normalizedProvider === "ollama" &&
    normalizedModelId.startsWith("kimi-k") &&
    normalizedModelId.includes(":cloud")
  );
}

export function createSiliconFlowThinkingWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (payloadObj.thinking === "off") {
            payloadObj.thinking = null;
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export function resolveMoonshotThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType | undefined {
  const configured = normalizeMoonshotThinkingType(params.configuredThinking);
  if (configured) {
    return configured;
  }
  if (!params.thinkingLevel) {
    return undefined;
  }
  return params.thinkingLevel === "off" ? "disabled" : "enabled";
}

export function createMoonshotThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingType?: MoonshotThinkingType,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          let effectiveThinkingType = normalizeMoonshotThinkingType(payloadObj.thinking);

          if (thinkingType) {
            payloadObj.thinking = { type: thinkingType };
            effectiveThinkingType = thinkingType;
          }

          if (
            effectiveThinkingType === "enabled" &&
            !isMoonshotToolChoiceCompatible(payloadObj.tool_choice)
          ) {
            if (payloadObj.tool_choice === "required") {
              payloadObj.tool_choice = "auto";
            } else if (isPinnedToolChoice(payloadObj.tool_choice)) {
              payloadObj.thinking = { type: "disabled" };
            }
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
