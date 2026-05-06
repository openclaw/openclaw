import { normalizeModelCompat } from "../../plugins/provider-model-compat.js";
import type { Api, Model } from "../pi-ai-contract.js";

export function normalizeResolvedProviderModel(params: {
  provider: string;
  model: Model<Api>;
}): Model<Api> {
  return normalizeModelCompat(params.model);
}
