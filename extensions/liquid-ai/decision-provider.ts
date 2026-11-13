import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { DecisionProviderV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  decodeLiquidDecisionResult,
  encodeLiquidDecisionRequest,
  supportsLiquidDecisionBatch,
  supportsLiquidImageDimensions,
} from "./decision-codec.js";

const BASE_URL = "https://api.liquid.ai/decisions/v1";
const loadDecisionHttp = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/decisions-http-runtime"),
);

function hasUnsupportedParams(context: DecisionProviderContextV2): boolean {
  const { config, agentId, model } = context;
  const agent = agentId ? resolveAgentConfig(config, agentId) : undefined;
  const modelRef = `liquid-ai/${model.id}`;
  // The native endpoint defines no generation or routing parameters. Never silently
  // discard an authored limit or privacy control inherited from another config layer.
  return [
    config.models?.providers?.["liquid-ai"]?.params,
    model.params,
    config.agents?.defaults?.params,
    config.agents?.defaults?.models?.[modelRef]?.params,
    agent?.models?.[modelRef]?.params,
    agent?.params,
  ].some((params) => Object.values(params ?? {}).some((value) => value !== undefined));
}

export function buildLiquidDecisionProvider(deps: {
  getImageMetadata: (buffer: Buffer) => Promise<{ width: number; height: number } | null>;
}): DecisionProviderV2 {
  return {
    id: "liquid-ai",
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      if (
        !["d1", "d1-ultra"].includes(context.model.id) ||
        (context.reasoning !== undefined && context.reasoning !== "auto") ||
        hasUnsupportedParams(context) ||
        !supportsLiquidDecisionBatch(batch)
      ) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const body = encodeLiquidDecisionRequest(batch, context.model.id);
      if (body === undefined) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      if (batch.state.type === "image") {
        const metadata = await deps
          .getImageMetadata(Buffer.from(batch.state.dataUri.split(",", 2)[1]!, "base64"))
          .catch(() => null);
        if (!supportsLiquidImageDimensions(metadata)) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
      }
      const { evaluateDecisionHttp } = await loadDecisionHttp();
      return evaluateDecisionHttp(context, {
        provider: "liquid-ai",
        baseUrl:
          context.model.baseUrl ??
          context.config.models?.providers?.["liquid-ai"]?.baseUrl ??
          BASE_URL,
        endpointPath: "systemone",
        body,
        decode: (payload) =>
          decodeLiquidDecisionResult(batch, payload, context.model.inference?.decision),
      });
    },
  };
}
