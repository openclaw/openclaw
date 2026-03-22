import { resolveProviderModernModelRef } from "../plugins/provider-runtime.js";

export type ModelRef = {
  provider?: string | null;
  id?: string | null;
};

export function isModernModelRef(ref: ModelRef): boolean {
  const provider = ref.provider?.trim().toLowerCase() ?? "";
  const id = ref.id?.trim().toLowerCase() ?? "";
  if (!provider || !id) {
    return false;
  }

  const pluginDecision = resolveProviderModernModelRef({
    provider,
    context: {
      provider,
      modelId: id,
    },
  });
  if (typeof pluginDecision === "boolean") {
    return pluginDecision;
  }
  return false;
}
