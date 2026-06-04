function summarizeGatewayLifecycleError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "error";
  }
}

const GATEWAY_LIFECYCLE_TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  /gateway timeout/i,
  /gateway closed/i,
  /handshake timeout/i,
  /closed before connect/i,
  /not yet ready to accept connections/i,
];

export function isGatewayLifecycleTransientError(error: unknown): boolean {
  const message = summarizeGatewayLifecycleError(error);
  return Boolean(
    message && GATEWAY_LIFECYCLE_TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message)),
  );
}
