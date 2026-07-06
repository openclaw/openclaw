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

// WebSocket close codes that indicate a permanent policy or auth failure
// rather than a transient gateway issue. These should NOT be retried.
//  - 1008 = Policy Violation (pairing required, scope mismatch, etc.)
//  - 1003 = Unsupported Data
//  - 1007 = Invalid Frame Payload Data
const GATEWAY_LIFECYCLE_PERMANENT_CLOSE_RE = /gateway closed[^(]*\((?:1008|1003|1007)\b/i;

const GATEWAY_LIFECYCLE_PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  // Permanent close codes reported in gateway error messages
  GATEWAY_LIFECYCLE_PERMANENT_CLOSE_RE,
  // Explicit auth / permission denials
  /unauthorized/i,
  /forbidden/i,
  /authentication failed/i,
  /access denied/i,
];

const GATEWAY_LIFECYCLE_TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  /gateway timeout/i,
  /gateway closed/i,
  /handshake timeout/i,
  /closed before connect/i,
  /not yet ready to accept connections/i,
];

export function isGatewayLifecycleTransientError(error: unknown): boolean {
  const message = summarizeGatewayLifecycleError(error);
  if (!message) {
    return false;
  }
  // Permanent failures (policy/auth/close-code) fail fast — never retry.
  if (GATEWAY_LIFECYCLE_PERMANENT_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }
  return GATEWAY_LIFECYCLE_TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
