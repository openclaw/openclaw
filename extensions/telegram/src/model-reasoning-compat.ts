import { stripSelfProviderModelPrefix } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

/**
 * Resolves the user-authored `compat.emitsReasoningInContent` opt-in flag for the
 * provider/model pair selected for a run. Returns true only when the configured row
 * explicitly opts in; absent or unknown models stay false so well-behaved endpoints
 * keep their normal streaming behavior.
 */
export function resolveEmitsReasoningInContent(
  cfg: OpenClawConfig,
  provider: string,
  modelId: string,
): boolean {
  const trimmedProvider = provider.trim();
  const trimmedModel = modelId.trim();
  if (!trimmedProvider || !trimmedModel) {
    return false;
  }
  const providerConfig = resolveMergedModelProviderConfig(cfg, trimmedProvider);
  const models = providerConfig?.models;
  if (!models?.length) {
    return false;
  }
  const normalize = (id: string) => id.trim().toLowerCase();
  const normalizedModel = normalize(trimmedModel);
  for (const row of models) {
    const candidates = [row.id, stripSelfProviderModelPrefix(trimmedProvider, row.id)];
    if (candidates.some((id) => id === trimmedModel || normalize(id) === normalizedModel)) {
      return row.compat?.emitsReasoningInContent === true;
    }
  }
  return false;
}
