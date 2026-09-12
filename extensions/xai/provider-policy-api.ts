import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderFastModePolicyContext } from "openclaw/plugin-sdk/provider-model-types";
import { resolveXaiFastModelId } from "./fast-mode.js";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import { isXaiFrontierModelId, isXaiGrok46ModelId, normalizeXaiModelId } from "./model-id.js";
import { isXaiProviderId } from "./provider-id.js";

export function resolveFastModeSupport(ctx: ProviderFastModePolicyContext): boolean | undefined {
  if (!ctx.api || ctx.runtimeId !== "openclaw") {
    return undefined;
  }
  return (
    resolveXaiFastModelId({ id: ctx.modelId, provider: ctx.provider, api: ctx.api }) !== undefined
  );
}

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile {
  const modelId = normalizeXaiModelId(ctx.modelId.trim().toLowerCase());
  const isGrok43 =
    modelId === "grok-latest" || modelId === "grok-4.3" || modelId.startsWith("grok-4.3-");
  const reasoning = ctx.reasoning ?? resolveXaiCatalogEntry(modelId)?.reasoning ?? isGrok43;
  if (!isXaiProviderId(ctx.provider) || !reasoning) {
    return { levels: [{ id: "off" }], defaultLevel: "off" };
  }
  if (isXaiFrontierModelId(modelId)) {
    const levels: ProviderThinkingProfile["levels"] = isXaiGrok46ModelId(modelId)
      ? [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }]
      : [{ id: "low" }, { id: "medium" }, { id: "high" }];
    return {
      levels,
      defaultLevel: "high",
    };
  }
  if (!isGrok43) {
    return { levels: [{ id: "off" }], defaultLevel: "off" };
  }
  return {
    levels: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    defaultLevel: "low",
  };
}
