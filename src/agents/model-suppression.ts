import { resolveProviderBuiltInModelSuppression } from "../plugins/provider-runtime.js";
import { normalizeProviderId } from "./provider-id.js";

function resolveBuiltInModelSuppression(params: { provider?: string | null; id?: string | null }) {
  const provider = normalizeProviderId(params.provider?.trim().toLowerCase() ?? "");
  const modelId = params.id?.trim().toLowerCase() ?? "";
  if (!provider || !modelId) {
    return undefined;
  }
  return resolveProviderBuiltInModelSuppression({
    env: process.env,
    context: {
      env: process.env,
      provider,
      modelId,
    },
  });
}

export function shouldSuppressBuiltInModel(params: {
  provider?: string | null;
  id?: string | null;
}) {
  return resolveBuiltInModelSuppression(params)?.suppress ?? false;
}

export function buildSuppressedBuiltInModelError(params: {
  provider?: string | null;
  id?: string | null;
}): string | undefined {
  return resolveBuiltInModelSuppression(params)?.errorMessage;
}
