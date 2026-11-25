import {
  normalizeBillingError,
  type BillingError,
} from "@openclaw/normalization-core/billing-error";
import { inferSignalStatus } from "./classification-rules.js";
import type { FallbackAttemptRecord } from "./error.js";
import type { PreparedProviderFailoverOwner } from "./provider-patterns.js";
import type { FailoverReason, FailoverSignal } from "./signal.js";

export function formatProviderBillingError(
  signal: FailoverSignal,
  context?: { providerOwner?: PreparedProviderFailoverOwner | null; model?: string },
) {
  const owner = context?.providerOwner;
  try {
    if (!owner?.formatBillingError) {
      return undefined;
    }
    const status = inferSignalStatus(signal);
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
          status,
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
  reason?: FailoverReason;
  provider?: string;
  model?: string;
  authMode?: string;
  billingError?: BillingError;
  attempts?: readonly (FallbackAttemptRecord & { authMode?: string })[];
}) {
  const attempts = params.attempts;
  if (!attempts?.length) {
    return !params.reason || params.reason === "billing" ? params : undefined;
  }
  let first: (typeof attempts)[number] | undefined;
  let subscription: (typeof attempts)[number] | undefined;
  for (const attempt of attempts) {
    if (attempt.reason !== "billing") {
      continue;
    }
    if (attempt.billingError) {
      return attempt;
    }
    first ??= attempt;
    if (attempt.authMode === "oauth" || attempt.authMode === "token") {
      subscription ??= attempt;
    }
  }
  return subscription ?? first;
}
