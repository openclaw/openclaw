import { normalizeOptionalString as normalizeModel } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "./model-selection.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "./providers/index.js";
import { resolveQaLiveFrontierAlternateModel } from "./providers/live-frontier/model-selection.runtime.js";

export { defaultQaModelForMode as defaultQaRuntimeModelForMode };

export function resolveQaRuntimeModelPair(params: {
  providerMode: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
}) {
  const providerMode = normalizeQaProviderMode(params.providerMode);
  const primaryModel = normalizeModel(params.primaryModel) ?? defaultQaModelForMode(providerMode);
  const alternateModel =
    normalizeModel(params.alternateModel) ??
    (providerMode === DEFAULT_QA_LIVE_PROVIDER_MODE
      ? (resolveQaLiveFrontierAlternateModel(primaryModel) ??
        defaultQaModelForMode(providerMode, { alternate: true }))
      : defaultQaModelForMode(providerMode, { alternate: true }));
  return { primaryModel, alternateModel };
}
