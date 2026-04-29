import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";
import { isFireworksKimiModelId } from "./model-id.js";

function isFireworksProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return normalized === "fireworks" || normalized === "fireworks-ai";
}

function isFireworksKimiK2p6ModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  const lastSegment = normalized.split("/").pop() ?? normalized;
  // Fireworks exposes Kimi K2.6 as either a raw model id or a router alias.
  // Examples:
  // - accounts/fireworks/models/kimi-k2p6
  // - accounts/fireworks/routers/kimi-k2.6-turbo
  return /^kimi-k2(?:p6|[.-]6)(?:[-_].+)?$/.test(lastSegment);
}

export function createFireworksKimiThinkingDisabledWrapper(
  baseStreamFn: StreamFn | undefined,
  opts?: {
    /**
     * Some K2.6 responses appear to carry the visible text through
     * reasoning fields; deleting them can yield an empty terminal result.
     */
    stripReasoningFields?: boolean;
  },
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const stripReasoningFields = opts?.stripReasoningFields ?? true;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      // Fireworks Kimi can emit chain-of-thought in visible `content` unless
      // the Anthropic-style thinking toggle is explicitly disabled.
      payloadObj.thinking = { type: "disabled" };
      if (stripReasoningFields) {
        delete payloadObj.reasoning;
        delete payloadObj.reasoning_effort;
        delete payloadObj.reasoningEffort;
      }
    });
}

export function wrapFireworksProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  if (
    !isFireworksProviderId(ctx.provider) ||
    ctx.model?.api !== "openai-completions" ||
    !isFireworksKimiModelId(ctx.modelId)
  ) {
    return undefined;
  }
  return createFireworksKimiThinkingDisabledWrapper(ctx.streamFn, {
    // Preserve reasoning fields for K2.6 to avoid empty terminal results.
    stripReasoningFields: !isFireworksKimiK2p6ModelId(ctx.modelId),
  });
}
