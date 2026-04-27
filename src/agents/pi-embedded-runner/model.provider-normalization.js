import { normalizeModelCompat } from "../../plugins/provider-model-compat.js";
export function normalizeResolvedProviderModel(params) {
    return normalizeModelCompat(params.model);
}
