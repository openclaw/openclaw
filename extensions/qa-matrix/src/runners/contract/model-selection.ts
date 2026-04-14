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
  const primaryModel = params.primaryModel?.trim();
  const alternateModel = params.alternateModel?.trim();
  if (primaryModel && alternateModel) {
    return {
      providerMode,
      primaryModel,
      alternateModel,
    };
  }

  const qaLabRuntime = loadQaLabRuntimeModule();
  return {
    providerMode,
    primaryModel: primaryModel || qaLabRuntime.defaultQaRuntimeModelForMode(providerMode),
    alternateModel:
      alternateModel || qaLabRuntime.defaultQaRuntimeModelForMode(providerMode, { alternate: true }),
  };
}
