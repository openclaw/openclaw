import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "openclaw/plugin-sdk/provider-catalog-shared";

/**
 * Resolves the user-authored `compat.emitsReasoningInContent` opt-in flag for the
 * provider/model pair selected for a run. The host's configured-row resolver picks
 * the row (exact id, then a case-insensitive id, then a self-provider-prefixed row);
 * absent or unknown models stay false so well-behaved endpoints keep their normal
 * streaming behavior.
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
  const row = findConfiguredProviderModel(
    resolveMergedModelProviderConfig(cfg, trimmedProvider),
    trimmedProvider,
    trimmedModel,
    (id) => id.toLowerCase(),
  );
  return row?.compat?.emitsReasoningInContent === true;
}
