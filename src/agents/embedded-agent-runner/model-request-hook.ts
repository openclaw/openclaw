import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { buildEmbeddedAgentHookContext } from "./run/agent-hook-context.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

// Provider-hosted tools run remotely with no later local gate, and their authorization
// is settled before this hook. Content policy may rewrite messages, never the tool surface.
const TOOL_SURFACE_FIELDS = ["tools", "tool_choice", "toolConfig", "functions", "function_call"];

/** Wire view of the tool fields: JSON drops undefined members a cloned replacement loses. */
function readToolSurface(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "[]";
  }
  const config: unknown = Reflect.get(payload, "config");
  const nested = typeof config === "object" && config !== null ? config : {};
  const fields = [payload, nested].flatMap((owner) =>
    TOOL_SURFACE_FIELDS.map((field) => Reflect.get(owner, field)),
  );
  return JSON.stringify(fields);
}

/** Policy sees final provider bytes and a detached copy of host message provenance. */
export function createModelRequestTransformer(hookContext: PluginHookAgentContext) {
  return async (payload: unknown, model: Model, context: Context): Promise<unknown> => {
    const hooks = getGlobalHookRunner();
    if (!hooks?.hasHooks("before_model_request")) {
      return payload;
    }
    const result = await hooks.runBeforeModelRequest(
      {
        payload,
        provider: model.provider,
        model: model.id,
        messages: structuredClone(context.messages),
      },
      hookContext,
    );
    if (!result) {
      return payload;
    }
    if (readToolSurface(result.payload) !== readToolSurface(payload)) {
      throw new Error("before_model_request replacement must not change the provider tool surface");
    }
    return result.payload;
  };
}

/** Binds the final request gate to the attempt's agent hook context. */
export function createAttemptModelRequestTransformer(
  attempt: EmbeddedRunAttemptParams,
  agentId: string,
) {
  return createModelRequestTransformer({
    ...buildEmbeddedAgentHookContext(attempt, agentId, undefined),
    modelProviderId: attempt.model.provider,
    modelId: attempt.model.id,
  });
}
