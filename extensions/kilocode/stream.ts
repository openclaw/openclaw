import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_DEFAULT = "openclaw";
const KILOCODE_FEATURE_ENV_VAR = "KILOCODE_FEATURE";

type ThinkLevel = NonNullable<ProviderWrapStreamFnContext["thinkingLevel"]>;
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

function resolveKilocodeAppHeaders(): Record<string, string> {
  const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
  return { [KILOCODE_FEATURE_HEADER]: feature };
}

function mapThinkingLevelToReasoningEffort(thinkingLevel: ThinkLevel): ReasoningEffort {
  if (thinkingLevel === "off") {
    return "none";
  }
  if (thinkingLevel === "adaptive") {
    return "medium";
  }
  if (thinkingLevel === "max") {
    return "xhigh";
  }
  return thinkingLevel;
}

function normalizeKilocodeReasoningPayload(
  payloadObj: Record<string, unknown>,
  thinkingLevel?: ThinkLevel,
): void {
  delete payloadObj.reasoning_effort;
  if (!thinkingLevel || thinkingLevel === "off") {
    return;
  }

  const existingReasoning = payloadObj.reasoning;
  if (
    existingReasoning &&
    typeof existingReasoning === "object" &&
    !Array.isArray(existingReasoning)
  ) {
    const reasoningObj = existingReasoning as Record<string, unknown>;
    if (!("max_tokens" in reasoningObj) && !("effort" in reasoningObj)) {
      reasoningObj.effort = mapThinkingLevelToReasoningEffort(thinkingLevel);
    }
  } else if (!existingReasoning) {
    payloadObj.reasoning = {
      effort: mapThinkingLevelToReasoningEffort(thinkingLevel),
    };
  }
}

function normalizeKilocodeStopPayload(payloadObj: Record<string, unknown>): void {
  if (typeof payloadObj.stop === "string") {
    payloadObj.stop = [payloadObj.stop];
  }
}

function isProxyReasoningUnsupported(modelId: string): boolean {
  const trimmed = normalizeOptionalLowercaseString(modelId);
  const slashIndex = trimmed?.indexOf("/") ?? -1;
  return slashIndex > 0 && trimmed?.slice(0, slashIndex) === "x-ai";
}

function resolveKilocodeThinkingLevel(ctx: ProviderWrapStreamFnContext): ThinkLevel | undefined {
  if (ctx.modelId === "kilo/auto" || isProxyReasoningUnsupported(ctx.modelId)) {
    return undefined;
  }
  return ctx.thinkingLevel;
}

export function createKilocodeStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers: {
          ...options?.headers,
          ...resolveKilocodeAppHeaders(),
        },
      },
      (payloadObj) => {
        normalizeKilocodeReasoningPayload(payloadObj, thinkingLevel);
        normalizeKilocodeStopPayload(payloadObj);
      },
    );
}

export function wrapKilocodeProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (normalizeOptionalLowercaseString(ctx.provider) !== "kilocode") {
    return undefined;
  }
  return createKilocodeStreamWrapper(ctx.streamFn, resolveKilocodeThinkingLevel(ctx));
}
