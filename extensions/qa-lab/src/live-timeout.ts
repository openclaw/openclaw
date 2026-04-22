import type { QaProviderMode } from "./model-selection.js";
import { getQaProvider } from "./providers/index.js";

type QaLiveTimeoutProfile = {
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
};

const QA_MOCK_CI_TURN_TIMEOUT_BONUS_MS = 15_000;

function isQaCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  const normalized = env.CI?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveQaLiveTurnTimeoutMs(
  profile: QaLiveTimeoutProfile,
  fallbackMs: number,
  modelRef = profile.primaryModel,
  env: NodeJS.ProcessEnv = process.env,
) {
  const provider = getQaProvider(profile.providerMode);
  const resolved = provider.resolveTurnTimeoutMs({
    primaryModel: profile.primaryModel,
    alternateModel: profile.alternateModel,
    modelRef,
    fallbackMs,
  });
  if (provider.kind === "mock" && isQaCiEnvironment(env)) {
    return Math.max(resolved, fallbackMs + QA_MOCK_CI_TURN_TIMEOUT_BONUS_MS);
  }
  return resolved;
}
