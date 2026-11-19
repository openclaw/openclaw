import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderFastModePolicyContext } from "openclaw/plugin-sdk/provider-model-types";
import { resolveXaiFastModelId } from "./fast-mode.js";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import {
  isXaiFrontierModelId,
  isXaiGrok43ModelId,
  isXaiXhighModelId,
  normalizeXaiModelId,
  normalizeXaiReasoningEfforts,
  resolveXaiIdReasoningEfforts,
} from "./model-id.js";
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
  const isGrok43 = isXaiGrok43ModelId(modelId);
  const reasoning = ctx.reasoning ?? resolveXaiCatalogEntry(modelId)?.reasoning ?? isGrok43;
  if (!isXaiProviderId(ctx.provider) || !reasoning) {
    return { levels: [{ id: "off" }], defaultLevel: "off" };
  }
  // Listed efforts (projected from the Grok subscription listing) replace the ID rules.
  // Runtime normalization stamps ID-ruled rows with their own effort list; an identical
  // list keeps the established ladder below.
  const listedEfforts = normalizeXaiReasoningEfforts(ctx.compat?.supportedReasoningEfforts ?? []);
  if (
    listedEfforts.length > 0 &&
    listedEfforts.join(",") !== resolveXaiIdReasoningEfforts(modelId).join(",")
  ) {
    const levels: ProviderThinkingProfile["levels"] = listedEfforts.map((effort) => ({
      id: effort === "none" ? "off" : effort,
    }));
    return {
      levels,
      defaultLevel: listedEfforts.includes("high") ? "high" : levels.at(-1)?.id,
    };
  }
  if (isXaiFrontierModelId(modelId)) {
    const levels: ProviderThinkingProfile["levels"] = isXaiXhighModelId(modelId)
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
