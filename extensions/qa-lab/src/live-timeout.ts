import type { QaProviderMode } from "./model-selection.js";
import { getQaProvider } from "./providers/index.js";

export function resolveQaLiveTurnTimeoutMs(
  profile: {
    providerMode: QaProviderMode;
    primaryModel: string;
    alternateModel: string;
  },
  fallbackMs: number,
  modelRef = profile.primaryModel,
) {
  return getQaProvider(profile.providerMode).resolveTurnTimeoutMs({
    modelRef,
    fallbackMs,
  });
}
