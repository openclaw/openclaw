import type {
  ProviderFailoverErrorContext,
  ProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";

/** DashScope uses the same quota code for temporary limits and exhausted free credits. */
export const classifyQwenFailoverReason: NonNullable<ProviderPlugin["classifyFailoverReason"]> = (
  context: ProviderFailoverErrorContext,
) => {
  if (context.status !== 429) {
    return undefined;
  }
  const codes = [context.code, context.errorType].map((code) => code?.trim().toLowerCase());
  if (codes.some((code) => code === "prepaidbilloverdue" || code === "postpaidbilloverdue")) {
    return "billing";
  }
  if (
    !codes.some((code) => code === "insufficient_quota" || code === "throttling.allocationquota")
  ) {
    return undefined;
  }
  // The code alone is ambiguous. Keep expired/free-only allocation out of
  // transient retry, and refine only the documented TPS/TPM messages.
  if (/\bfree allocated quota exceeded\b/i.test(context.errorMessage)) {
    return "billing";
  }
  if (
    /\ballocated quota exceeded, please increase your quota limit\b/i.test(context.errorMessage) ||
    /\byou exceeded your current quota, please check your plan and billing details\b/i.test(
      context.errorMessage,
    )
  ) {
    return "rate_limit";
  }
  // Bailian reuses 429/insufficient_quota for TPS/TPM throttles (#148236):
  // genuine billing errors carry BillOverdue codes (handled above) or
  // explicit exhausted-balance text. An unmarked quota message is a
  // transient throttle — prefer model-scoped cooldown over disabling the
  // auth profile for an ambiguous signal.
  if (/billoverdue|\bbill\s+overdue\b/i.test(context.errorMessage)) {
    return "billing";
  }
  if (/\binsufficient[_ ]balance\b/i.test(context.errorMessage)) {
    return "billing";
  }
  return "rate_limit";
};
