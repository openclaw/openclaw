import { expectDefined } from "@openclaw/normalization-core/expect";
import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/core";
import { resolveCopilotForwardCompatModel } from "./models.js";

export function createMockCtx(
  modelId: string,
  registryModels: Record<string, Record<string, unknown>> = {},
): ProviderResolveDynamicModelContext {
  return {
    modelId,
    provider: "github-copilot",
    config: {},
    modelRegistry: {
      find: (provider: string, id: string) => registryModels[`${provider}/${id}`] ?? null,
    },
  } as unknown as ProviderResolveDynamicModelContext;
}

export function requireResolvedModel(ctx: ProviderResolveDynamicModelContext) {
  return expectDefined(
    resolveCopilotForwardCompatModel(ctx),
    `expected model ${ctx.modelId} to resolve`,
  );
}
