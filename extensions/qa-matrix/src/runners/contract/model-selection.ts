import { loadQaLabRuntimeModule } from "openclaw/plugin-sdk/qa-lab-runtime";
import { normalizeQaProviderMode, type QaProviderModeInput } from "../../run-config.js";

export type ResolvedMatrixQaModels = {
  providerMode: ReturnType<typeof normalizeQaProviderMode>;
  primaryModel: string;
  alternateModel: string;
};

export function resolveMatrixQaModels(params: {
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
}): ResolvedMatrixQaModels {
  const providerMode = normalizeQaProviderMode(params.providerMode ?? "live-frontier");
  const qaLabRuntime = loadQaLabRuntimeModule();
  return {
    providerMode,
    primaryModel:
      params.primaryModel?.trim() ||
      qaLabRuntime.defaultQaRuntimeModelForMode(providerMode),
    alternateModel:
      params.alternateModel?.trim() ||
      qaLabRuntime.defaultQaRuntimeModelForMode(providerMode, { alternate: true }),
  };
}
