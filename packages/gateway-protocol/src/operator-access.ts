import { isProtocolRecord } from "./protocol-value-normalization.js";

// Closed, identity-free causes: a failed check never grants continued access.
const accessCauses = {
  "access-record-inactive": false,
  "profile-invalidated": false,
  "profile-unavailable": false,
  "plugin-lifetime-retired": true,
  "plugin-invocation-unavailable": false,
  "policy-unavailable": true,
  "policy-set-changed": true,
  "policy-rejected": false,
  "policy-check-failed": false,
  "grant-revoked": false,
} as const;

export type GatewayOperatorAccessCause = keyof typeof accessCauses;

export function readGatewayOperatorAccessCause(value: unknown): GatewayOperatorAccessCause | null {
  return typeof value === "string" && Object.hasOwn(accessCauses, value)
    ? (value as GatewayOperatorAccessCause) // SAFETY: the own-key check restricts value to this closed table.
    : null;
}

export function gatewayOperatorAccessError(cause: GatewayOperatorAccessCause) {
  const retryable = accessCauses[cause];
  return {
    code: "FORBIDDEN",
    message: `Gateway access stopped [access-cause=${cause}]; ${retryable ? "retry after policy refresh." : "ask an administrator to restore access."}`,
    details: { code: "OPERATOR_ACCESS_DENIED", accessCause: cause },
    retryable,
    ...(retryable ? { retryAfterMs: 30_000 } : {}),
  };
}

export function isGatewayOperatorAccessRetryable(details: unknown): boolean {
  const cause = isProtocolRecord(details)
    ? readGatewayOperatorAccessCause(details.accessCause)
    : null;
  return cause !== null && accessCauses[cause];
}

/** Only the access owner's coded closes participate; other 4001 policy changes still reconnect. */
export function readGatewayOperatorAccessClose(code: number, reason: string) {
  if (code !== 4001) {
    return null;
  }
  const coded = /^Gateway access stopped \[access-cause=([a-z-]+)\]; /.exec(reason);
  if (coded) {
    return gatewayOperatorAccessError(
      readGatewayOperatorAccessCause(coded[1]) ?? "policy-check-failed",
    );
  }
  // The deployed uncoded denial is terminal too; never infer a transient cause from its text.
  return reason ===
    "Gateway access is not active for this account; ask a Gateway administrator to grant or restore access."
    ? gatewayOperatorAccessError("policy-check-failed")
    : null;
}
