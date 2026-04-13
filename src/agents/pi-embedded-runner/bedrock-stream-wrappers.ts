import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { isAnthropicBedrockModel } from "./anthropic-family-cache-semantics.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

export function createBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      cacheRetention: "none",
    });
}

const BEDROCK_SERVICE_TIER_VALUES = ["flex", "priority", "default", "reserved"] as const;
export type BedrockServiceTier = (typeof BEDROCK_SERVICE_TIER_VALUES)[number];

export function resolveBedrockServiceTier(
  extraParams: Record<string, unknown> | undefined,
): BedrockServiceTier | undefined {
  const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
  if (typeof raw === "string" && BEDROCK_SERVICE_TIER_VALUES.includes(raw as BedrockServiceTier)) {
    return raw as BedrockServiceTier;
  }
  return undefined;
}

export function createBedrockServiceTierWrapper(
  baseStreamFn: StreamFn | undefined,
  serviceTier: BedrockServiceTier,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "bedrock-converse-stream") {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (payloadObj.serviceTier === undefined) {
        payloadObj.serviceTier = { type: serviceTier };
      }
    });
  };
}

export { isAnthropicBedrockModel };
