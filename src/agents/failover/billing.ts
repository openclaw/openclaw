import {
  normalizeBillingError,
  type BillingError,
} from "@openclaw/normalization-core/billing-error";
import type { FallbackAttemptRecord } from "./error.js";
import type { PreparedProviderFailoverOwner } from "./provider-patterns.js";
import type { FailoverSignal } from "./signal.js";

export function formatProviderBillingError(
  signal: Pick<FailoverSignal, "message" | "status" | "code" | "errorType">,
  context?: { providerOwner?: PreparedProviderFailoverOwner | null; model?: string },
) {
  const owner = context?.providerOwner;
  try {
    return normalizeBillingError(
      owner?.formatBillingError?.({
        provider: owner.id,
        modelId: context?.model,
        errorMessage: signal.message ?? "",
        status: signal.status,
        code: signal.code,
        errorType: signal.errorType,
      }),
    );
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
