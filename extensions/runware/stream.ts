// Runware plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

type RunwareToolSchema = {
  type?: string;
  properties?: Record<string, unknown>;
};

type RunwareTool = {
  type?: string;
  function?: { parameters?: RunwareToolSchema };
};

// Runware's server-side max_tokens default can exceed a model's real cap and
// 400. Clamp to the model's live-discovered maxTokens, not a hardcoded table.
function clampRunwareMaxTokens(payload: Record<string, unknown>, modelMaxTokens: number): void {
  const requested = payload.max_tokens;
  if (typeof requested !== "number" || requested > modelMaxTokens) {
    payload.max_tokens = modelMaxTokens;
  }
}

// Runware 400s on {"type":"object","properties":{}}, which OpenClaw's tool
// normalizer produces for parameter-less tools.
function patchRunwareEmptyToolSchemas(payload: Record<string, unknown>): void {
  const tools = payload.tools;
  if (!Array.isArray(tools)) {
    return;
  }
  for (const tool of tools as RunwareTool[]) {
    const schema = tool?.function?.parameters;
    if (!schema || typeof schema !== "object") {
      continue;
    }
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      schema.properties = {
        _unused: { type: "string", description: "Unused. This tool takes no parameters." },
      };
    }
  }
}

export function wrapRunwareProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (normalizeProviderId(ctx.provider) !== "runware") {
    return undefined;
  }
  return createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload, model }) => {
    clampRunwareMaxTokens(payload, model.maxTokens);
    patchRunwareEmptyToolSchemas(payload);
  });
}
