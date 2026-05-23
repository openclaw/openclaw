import type { Model } from "openclaw/plugin-sdk/llm";
import { normalizeModelCompat } from "../../plugins/provider-model-compat.js";

export function normalizeResolvedProviderModel(params: { provider: string; model: Model }): Model {
  return normalizeModelCompat(params.model);
}
