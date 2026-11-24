import {
  normalizeBillingError,
  type BillingError,
} from "@openclaw/normalization-core/billing-error";
import { inferSignalStatus } from "./classification-rules.js";
import type { FallbackAttemptRecord } from "./error.js";
import type { PreparedProviderFailoverOwner } from "./provider-patterns.js";
import type { FailoverSignal } from "./signal.js";

export function formatProviderBillingError(
  signal: FailoverSignal,
  context?: { providerOwner?: PreparedProviderFailoverOwner | null; model?: string },
) {
  const owner = context?.providerOwner;
  try {
    if (!owner?.formatBillingError) {
      return undefined;
    }
    for (const errorMessage of [
      signal.message ?? "",
      ...(signal.details ?? []),
      ...(signal.providerCauseDetails ?? []),
    ]) {
      const billingError = normalizeBillingError(
        owner.formatBillingError({
          provider: owner.id,
          modelId: context?.model,
          errorMessage,
          status: inferSignalStatus(signal),
          code: signal.code,
          errorType: signal.errorType,
        }),
      );
      if (billingError) {
        return billingError;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function resolveBillingFailure(params: {
  provider?: string;
  model?: string;
  authMode?: string;
  billingError?: BillingError;
  attempts?: readonly (FallbackAttemptRecord & { authMode?: string })[];
}) {
  const attempts = params.attempts ?? [];
  return attempts.length > 0
    ? (attempts.find((attempt) => attempt.reason === "billing" && attempt.billingError) ??
        attempts.find(
          (attempt) =>
            attempt.reason === "billing" &&
            (attempt.authMode === "oauth" || attempt.authMode === "token"),
        ) ??
        attempts.find((attempt) => attempt.reason === "billing"))
    : params;
}
