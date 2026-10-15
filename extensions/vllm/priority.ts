import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-metadata";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function wrapVllmPriorityStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const underlying = ctx.streamFn;
  if (
    !underlying ||
    normalizeProviderId(ctx.provider) !== "vllm" ||
    ctx.modelParams?.priorityScheduling !== true
  ) {
    return underlying;
  }
  const priority =
    ctx.modelCallUrgency === "foreground" ? -100 : ctx.modelCallUrgency === "background" ? 100 : 0;
  const wrapped: StreamFn = (model, context, options) => {
    if (
      normalizeProviderId(model.provider) !== "vllm" ||
      model.id !== ctx.modelId ||
      (ctx.sourceApi ?? model.api) !== "openai-completions"
    ) {
      return underlying(model, context, options);
    }
    return underlying(model, context, {
      ...options,
      onPayload: async (payload, requestModel) => {
        // Explicit dynamic scheduling owns priority after ordinary payload overrides.
        // Mutate only this request; fallback models keep their own configured fields.
        const result = (await options?.onPayload?.(payload, requestModel)) ?? payload;
        const body = asOptionalObjectRecord(result);
        if (body) {
          body.priority = priority;
        }
        return result;
      },
    });
  };
  return Object.assign(wrapped, { preservesGenericCompatibility: true });
}
