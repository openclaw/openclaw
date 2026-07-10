// Xai API module exposes the plugin public contract.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import { normalizeXaiModelId } from "./model-id.js";

// The xAI plugin registers "x-ai" as a canonical alias of "xai".
// Both provider IDs must resolve to the same thinking profile.
const XAI_PROVIDER_IDS = new Set(["xai", "x-ai"]);

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile {
  const reasoning = ctx.reasoning ?? resolveXaiCatalogEntry(ctx.modelId)?.reasoning;
  if (!XAI_PROVIDER_IDS.has(ctx.provider) || !reasoning) {
    return { levels: [{ id: "off" }], defaultLevel: "off" };
  }
  const modelId = normalizeXaiModelId(ctx.modelId.trim().toLowerCase());
  const isGrok45 = modelId === "grok-4.5" || modelId.startsWith("grok-4.5-");
  if (isGrok45) {
    return {
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "high",
    };
  }
  const isGrok43 =
    modelId === "grok-latest" || modelId === "grok-4.3" || modelId.startsWith("grok-4.3-");
  if (!isGrok43) {
    return { levels: [{ id: "off" }], defaultLevel: "off" };
  }
  return {
    levels: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    defaultLevel: "low",
  };
}
