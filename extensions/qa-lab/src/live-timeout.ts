// Qa Lab plugin module implements live timeout behavior.
import {
  parseStrictPositiveInteger,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { QaProviderMode } from "./model-selection.js";
import { getQaProvider } from "./providers/index.js";

type QaLiveTimeoutProfile = {
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
};

const QA_LIVE_TURN_TIMEOUT_MS_ENV = "OPENCLAW_QA_LIVE_TURN_TIMEOUT_MS";

function resolveLiveTurnFallbackMs(fallbackMs: number) {
  const callerFallbackMs = resolveTimerTimeoutMs(fallbackMs, 1);
  const raw = process.env[QA_LIVE_TURN_TIMEOUT_MS_ENV];
  if (raw === undefined) {
    return callerFallbackMs;
  }
  return Math.max(
    callerFallbackMs,
    resolveTimerTimeoutMs(parseStrictPositiveInteger(raw), fallbackMs),
  );
}

export function resolveQaLiveTurnTimeoutMs(
  profile: QaLiveTimeoutProfile,
  fallbackMs: number,
  modelRef = profile.primaryModel,
) {
  const resolvedFallbackMs = resolveLiveTurnFallbackMs(fallbackMs);
  return getQaProvider(profile.providerMode).resolveTurnTimeoutMs({
    primaryModel: profile.primaryModel,
    alternateModel: profile.alternateModel,
    modelRef,
    fallbackMs: resolvedFallbackMs,
  });
}
