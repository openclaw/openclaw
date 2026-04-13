import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { isAnthropicBedrockModel } from "./anthropic-family-cache-semantics.js";
import { log } from "./logger.js";
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
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase() as BedrockServiceTier;
    if (BEDROCK_SERVICE_TIER_VALUES.includes(normalized)) {
      return normalized;
    }
    log.warn(`ignoring invalid Bedrock service_tier param: ${raw}`);
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
    console.error(
      `[bedrock-service-tier] Applying service_tier=${serviceTier} to model=${model.id}`,
    );
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (payloadObj.serviceTier === undefined) {
        payloadObj.serviceTier = { type: serviceTier };
        console.error(
          `[bedrock-service-tier] Injected serviceTier into payload:`,
          JSON.stringify(payloadObj.serviceTier),
        );
      }
    });
  };
}

export { isAnthropicBedrockModel };
