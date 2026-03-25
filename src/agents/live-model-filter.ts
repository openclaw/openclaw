import { resolveProviderModernModelRef } from "../plugins/provider-runtime.js";

export type ModelRef = {
  provider?: string | null;
  id?: string | null;
};

function isHighSignalClaudeModelId(id: string): boolean {
  if (!/\bclaude\b/i.test(id)) {
    return true;
  }
  if (/\bhaiku\b/i.test(id)) {
    return false;
  }
  if (/\bclaude-3(?:[-.]5|[-.]7)\b/i.test(id)) {
    return false;
  }
  return true;
}

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

export function isHighSignalLiveModelRef(ref: ModelRef): boolean {
  const id = ref.id?.trim().toLowerCase() ?? "";
  if (!isModernModelRef(ref) || !id) {
    return false;
  }
  return isHighSignalClaudeModelId(id);
}
