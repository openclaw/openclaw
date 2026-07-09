// Xai API module exposes the plugin public contract.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveXaiCatalogEntry } from "./model-definitions.js";

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile {
  const reasoning = ctx.reasoning ?? resolveXaiCatalogEntry(ctx.modelId)?.reasoning;
  if (ctx.provider !== "xai" || !reasoning) {
    return { levels: [{ id: "off" }], defaultLevel: "off" };
  }
  const modelId = ctx.modelId.trim().toLowerCase();
  const isGrok45 =
    modelId === "grok-4.5" || modelId.startsWith("grok-4.5-") || modelId === "grok-build-latest";
  if (isGrok45) {
    return {
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "high",
    };
  }
  return {
    levels: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    defaultLevel: "low",
  };
}
