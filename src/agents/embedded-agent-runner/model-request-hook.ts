import type { Context, Model } from "openclaw/plugin-sdk/llm";
import type { PluginHookModelRequestKind } from "../../plugins/hook-model.types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { buildEmbeddedAgentHookContext } from "./run/agent-hook-context.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

// Tool, model, and Access-program authorization is settled before this hook; provider-hosted
// tools have no later local gate. Content policy may rewrite messages, never these fields.
const PROTECTED_FIELDS = [
  "tools",
  "tool_choice",
  "toolConfig",
  "functions",
  "function_call",
  "model",
  "access_programs",
];

/** Wire view of the protected fields: JSON drops undefined members a cloned replacement loses. */
function readProtectedFields(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "[]";
  }
  const config: unknown = Reflect.get(payload, "config");
  const nested = typeof config === "object" && config !== null ? config : {};
  const fields = [payload, nested].flatMap((owner) =>
    PROTECTED_FIELDS.map((field) => Reflect.get(owner, field)),
  );
  return JSON.stringify(fields);
}

/** Policy sees final provider bytes and a detached copy of host message provenance. */
export function createModelRequestTransformer(
  hookContext: PluginHookAgentContext,
  requestKind: PluginHookModelRequestKind = "turn",
) {
  return async (payload: unknown, model: Model, context: Context): Promise<unknown> => {
    const hooks = getGlobalHookRunner();
    if (!hooks?.hasHooks("before_model_request")) {
      return payload;
    }
    // Snapshot before dispatch: handlers receive the payload by reference and may mutate it.
    const admitted = readProtectedFields(payload);
    const result = await hooks.runBeforeModelRequest(
      {
        runtime: "embedded",
        requestKind,
        payload,
        provider: model.provider,
        model: model.id,
        messages: structuredClone(context.messages),
      },
      hookContext,
    );
    const effective = result ? result.payload : payload;
    if (readProtectedFields(effective) !== admitted) {
      throw new Error(
        "before_model_request must not change the provider tool surface, model, or access programs",
      );
    }
    return effective;
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
