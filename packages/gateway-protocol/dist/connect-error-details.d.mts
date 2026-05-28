//#region packages/gateway-protocol/src/connect-error-details.d.ts
declare const ConnectErrorDetailCodes: {
  readonly AUTH_REQUIRED: "AUTH_REQUIRED";
  readonly AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED";
  readonly AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING";
  readonly AUTH_TOKEN_MISMATCH: "AUTH_TOKEN_MISMATCH";
  readonly AUTH_TOKEN_NOT_CONFIGURED: "AUTH_TOKEN_NOT_CONFIGURED";
  readonly AUTH_PASSWORD_MISSING: "AUTH_PASSWORD_MISSING";
  readonly AUTH_PASSWORD_MISMATCH: "AUTH_PASSWORD_MISMATCH";
  readonly AUTH_PASSWORD_NOT_CONFIGURED: "AUTH_PASSWORD_NOT_CONFIGURED";
  readonly AUTH_BOOTSTRAP_TOKEN_INVALID: "AUTH_BOOTSTRAP_TOKEN_INVALID";
  readonly AUTH_DEVICE_TOKEN_MISMATCH: "AUTH_DEVICE_TOKEN_MISMATCH";
  readonly AUTH_SCOPE_MISMATCH: "AUTH_SCOPE_MISMATCH";
  readonly AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED";
  readonly AUTH_TAILSCALE_IDENTITY_MISSING: "AUTH_TAILSCALE_IDENTITY_MISSING";
  readonly AUTH_TAILSCALE_PROXY_MISSING: "AUTH_TAILSCALE_PROXY_MISSING";
  readonly AUTH_TAILSCALE_WHOIS_FAILED: "AUTH_TAILSCALE_WHOIS_FAILED";
  readonly AUTH_TAILSCALE_IDENTITY_MISMATCH: "AUTH_TAILSCALE_IDENTITY_MISMATCH";
  readonly CONTROL_UI_ORIGIN_NOT_ALLOWED: "CONTROL_UI_ORIGIN_NOT_ALLOWED";
  readonly PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH";
  readonly CONTROL_UI_DEVICE_IDENTITY_REQUIRED: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED";
  readonly DEVICE_IDENTITY_REQUIRED: "DEVICE_IDENTITY_REQUIRED";
  readonly DEVICE_AUTH_INVALID: "DEVICE_AUTH_INVALID";
  readonly DEVICE_AUTH_DEVICE_ID_MISMATCH: "DEVICE_AUTH_DEVICE_ID_MISMATCH";
  readonly DEVICE_AUTH_SIGNATURE_EXPIRED: "DEVICE_AUTH_SIGNATURE_EXPIRED";
  readonly DEVICE_AUTH_NONCE_REQUIRED: "DEVICE_AUTH_NONCE_REQUIRED";
  readonly DEVICE_AUTH_NONCE_MISMATCH: "DEVICE_AUTH_NONCE_MISMATCH";
  readonly DEVICE_AUTH_SIGNATURE_INVALID: "DEVICE_AUTH_SIGNATURE_INVALID";
  readonly DEVICE_AUTH_PUBLIC_KEY_INVALID: "DEVICE_AUTH_PUBLIC_KEY_INVALID";
  readonly PAIRING_REQUIRED: "PAIRING_REQUIRED";
  readonly CLIENT_VERSION_MISMATCH: "CLIENT_VERSION_MISMATCH";
};
type ConnectErrorDetailCode = (typeof ConnectErrorDetailCodes)[keyof typeof ConnectErrorDetailCodes];
declare const ConnectPairingRequiredReasons: {
  readonly NOT_PAIRED: "not-paired";
  readonly ROLE_UPGRADE: "role-upgrade";
  readonly SCOPE_UPGRADE: "scope-upgrade";
  readonly METADATA_UPGRADE: "metadata-upgrade";
};
type ConnectPairingRequiredReason = (typeof ConnectPairingRequiredReasons)[keyof typeof ConnectPairingRequiredReasons];
type ConnectRecoveryNextStep = "retry_with_device_token" | "update_auth_configuration" | "update_auth_credentials" | "wait_then_retry" | "review_auth_configuration";
type ConnectErrorRecoveryAdvice = {
  canRetryWithDeviceToken?: boolean;
  recommendedNextStep?: ConnectRecoveryNextStep;
};
type PairingConnectErrorDetails = {
  code: typeof ConnectErrorDetailCodes.PAIRING_REQUIRED;
  reason?: ConnectPairingRequiredReason;
  requestId?: string;
  remediationHint?: string;
  recommendedNextStep?: ConnectRecoveryNextStep;
  retryable?: boolean;
  pauseReconnect?: boolean;
  deviceId?: string;
  requestedRole?: string;
  requestedScopes?: string[];
  approvedRoles?: string[];
  approvedScopes?: string[];
};
type ConnectPairingRequiredDetails = Pick<PairingConnectErrorDetails, "reason" | "requestId">;
declare function resolveAuthConnectErrorDetailCode(reason: string | undefined): ConnectErrorDetailCode;
declare function resolveDeviceAuthConnectErrorDetailCode(reason: string | undefined): ConnectErrorDetailCode;
declare function readConnectErrorDetailCode(details: unknown): string | null;
declare function readConnectErrorRecoveryAdvice(details: unknown): ConnectErrorRecoveryAdvice;
declare function normalizePairingConnectRequestId(value: unknown): string | undefined;
declare function describePairingConnectRequirement(reason: ConnectPairingRequiredReason | undefined): string;
declare function buildPairingConnectErrorMessage(reason: ConnectPairingRequiredReason | undefined): string;
declare function buildPairingConnectRecoveryTitle(reason: ConnectPairingRequiredReason | undefined): string;
declare function buildPairingConnectErrorDetails(params: {
  reason: ConnectPairingRequiredReason | undefined;
  requestId?: string;
  remediationHint?: string;
  recommendedNextStep?: ConnectRecoveryNextStep;
  retryable?: boolean;
  pauseReconnect?: boolean;
  deviceId?: string;
  requestedRole?: string;
  requestedScopes?: string[];
  approvedRoles?: string[];
  approvedScopes?: string[];
}): PairingConnectErrorDetails;
declare function buildPairingConnectCloseReason(params: {
  reason: ConnectPairingRequiredReason | undefined;
  requestId?: string;
}): string;
declare function readPairingConnectErrorDetails(details: unknown): PairingConnectErrorDetails | null;
declare function readConnectPairingRequiredDetails(details: unknown): ConnectPairingRequiredDetails | null;
declare function readConnectPairingRequiredMessage(message: string | null | undefined): ConnectPairingRequiredDetails | null;
declare function formatConnectPairingRequiredMessage(details: unknown): string;
declare function formatConnectErrorMessage(params: {
  message?: string;
  details?: unknown;
}): string;
//#endregion
export { ConnectErrorDetailCode, ConnectErrorDetailCodes, ConnectErrorRecoveryAdvice, ConnectPairingRequiredDetails, ConnectPairingRequiredReason, ConnectPairingRequiredReasons, ConnectRecoveryNextStep, PairingConnectErrorDetails, buildPairingConnectCloseReason, buildPairingConnectErrorDetails, buildPairingConnectErrorMessage, buildPairingConnectRecoveryTitle, describePairingConnectRequirement, formatConnectErrorMessage, formatConnectPairingRequiredMessage, normalizePairingConnectRequestId, readConnectErrorDetailCode, readConnectErrorRecoveryAdvice, readConnectPairingRequiredDetails, readConnectPairingRequiredMessage, readPairingConnectErrorDetails, resolveAuthConnectErrorDetailCode, resolveDeviceAuthConnectErrorDetailCode };