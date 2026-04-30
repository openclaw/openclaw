export type CursorSdkModule = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AuthenticationError: new (...args: any[]) => Error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RateLimitError: new (...args: any[]) => Error;
};

export type CursorSdkErrorReason = "auth" | "rate_limit" | "billing" | "timeout" | "unclassified";

export function classifyCursorSdkError(
  err: unknown,
  elapsed: number,
  timeoutMs: number,
  sdkModule?: CursorSdkModule,
): CursorSdkErrorReason {
  const message = err instanceof Error ? err.message : "";

  if (sdkModule) {
    if (err instanceof sdkModule.AuthenticationError) {
      return "auth";
    }
    if (err instanceof sdkModule.RateLimitError) {
      return "rate_limit";
    }
  }

  if (elapsed >= timeoutMs || /timeout/i.test(message)) {
    return "timeout";
  }
  if (/rate.?limit|429|too many requests/i.test(message)) {
    return "rate_limit";
  }
  if (/auth|401|unauthorized|forbidden|403/i.test(message)) {
    return "auth";
  }
  if (/billing|payment|quota|insufficient/i.test(message)) {
    return "billing";
  }

  return "unclassified";
}
