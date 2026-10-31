import { classifyFailoverReasonCore, classifyFailoverSignalCore } from "./classify-core.js";
import {
  classifyProviderPluginError,
  type PreparedProviderFailoverOwner,
} from "./provider-patterns.js";
import type { FailoverClassification, FailoverReason, FailoverSignal } from "./signal.js";
export { isUnclassifiedNoBodyHttpSignal } from "./classification-rules.js";
export { isLikelyContextOverflowError } from "./context-overflow.js";
export {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isProviderCompletedErrorFinishReasonMessage,
  isProviderRequestSizeCeilingError,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./message-patterns.js";
export { extractFailoverSignalDetails } from "./signal-details.js";

export function classifyFailoverSignal(
  signal: FailoverSignal,
  opts?: { providerPlugin?: PreparedProviderFailoverOwner | null },
): FailoverClassification | null {
  return classifyFailoverSignalCore(signal, (context) =>
    classifyProviderPluginError({ ...context, providerPlugin: opts?.providerPlugin }),
  );
}

export function classifyFailoverReason(
  raw: string,
  opts?: { provider?: string; providerPlugin?: PreparedProviderFailoverOwner | null },
): FailoverReason | null {
  return classifyFailoverReasonCore(raw, opts, (context) =>
    classifyProviderPluginError({ ...context, providerPlugin: opts?.providerPlugin }),
  );
}
