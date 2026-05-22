import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/gateway/protocol/connect-error-details.ts
const ConnectErrorDetailCodes = {
	AUTH_REQUIRED: "AUTH_REQUIRED",
	AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
	AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
	AUTH_TOKEN_MISMATCH: "AUTH_TOKEN_MISMATCH",
	AUTH_TOKEN_NOT_CONFIGURED: "AUTH_TOKEN_NOT_CONFIGURED",
	AUTH_PASSWORD_MISSING: "AUTH_PASSWORD_MISSING",
	AUTH_PASSWORD_MISMATCH: "AUTH_PASSWORD_MISMATCH",
	AUTH_PASSWORD_NOT_CONFIGURED: "AUTH_PASSWORD_NOT_CONFIGURED",
	AUTH_BOOTSTRAP_TOKEN_INVALID: "AUTH_BOOTSTRAP_TOKEN_INVALID",
	AUTH_DEVICE_TOKEN_MISMATCH: "AUTH_DEVICE_TOKEN_MISMATCH",
	AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED",
	AUTH_TAILSCALE_IDENTITY_MISSING: "AUTH_TAILSCALE_IDENTITY_MISSING",
	AUTH_TAILSCALE_PROXY_MISSING: "AUTH_TAILSCALE_PROXY_MISSING",
	AUTH_TAILSCALE_WHOIS_FAILED: "AUTH_TAILSCALE_WHOIS_FAILED",
	AUTH_TAILSCALE_IDENTITY_MISMATCH: "AUTH_TAILSCALE_IDENTITY_MISMATCH",
	CONTROL_UI_ORIGIN_NOT_ALLOWED: "CONTROL_UI_ORIGIN_NOT_ALLOWED",
	CONTROL_UI_DEVICE_IDENTITY_REQUIRED: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
	DEVICE_IDENTITY_REQUIRED: "DEVICE_IDENTITY_REQUIRED",
	DEVICE_AUTH_INVALID: "DEVICE_AUTH_INVALID",
	DEVICE_AUTH_DEVICE_ID_MISMATCH: "DEVICE_AUTH_DEVICE_ID_MISMATCH",
	DEVICE_AUTH_SIGNATURE_EXPIRED: "DEVICE_AUTH_SIGNATURE_EXPIRED",
	DEVICE_AUTH_NONCE_REQUIRED: "DEVICE_AUTH_NONCE_REQUIRED",
	DEVICE_AUTH_NONCE_MISMATCH: "DEVICE_AUTH_NONCE_MISMATCH",
	DEVICE_AUTH_SIGNATURE_INVALID: "DEVICE_AUTH_SIGNATURE_INVALID",
	DEVICE_AUTH_PUBLIC_KEY_INVALID: "DEVICE_AUTH_PUBLIC_KEY_INVALID",
	PAIRING_REQUIRED: "PAIRING_REQUIRED"
};
const ConnectPairingRequiredReasons = {
	NOT_PAIRED: "not-paired",
	ROLE_UPGRADE: "role-upgrade",
	SCOPE_UPGRADE: "scope-upgrade",
	METADATA_UPGRADE: "metadata-upgrade"
};
const CONNECT_RECOVERY_NEXT_STEP_VALUES = new Set([
	"retry_with_device_token",
	"update_auth_configuration",
	"update_auth_credentials",
	"wait_then_retry",
	"review_auth_configuration"
]);
const CONNECT_PAIRING_REQUIRED_REASON_VALUES = new Set([
	"not-paired",
	"role-upgrade",
	"scope-upgrade",
	"metadata-upgrade"
]);
const PAIRING_CONNECT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PAIRING_CONNECT_REASON_METADATA = {
	"not-paired": {
		requirement: "device is not approved yet",
		remediationHint: "Approve this device from the pending pairing requests.",
		recoveryTitle: "Gateway pairing approval required."
	},
	"role-upgrade": {
		requirement: "device is asking for a higher role than currently approved",
		remediationHint: "Review the requested role upgrade, then approve the pending request.",
		recoveryTitle: "Gateway role upgrade approval required."
	},
	"scope-upgrade": {
		requirement: "device is asking for more scopes than currently approved",
		remediationHint: "Review the requested scopes, then approve the pending upgrade.",
		recoveryTitle: "Gateway scope upgrade approval required."
	},
	"metadata-upgrade": {
		requirement: "device identity changed and must be re-approved",
		remediationHint: "Review the refreshed device details, then approve the pending request.",
		recoveryTitle: "Gateway device refresh approval required."
	}
};
const CONNECT_PAIRING_REQUIRED_MESSAGE_BY_REASON = {
	"not-paired": "device pairing required",
	"role-upgrade": "role upgrade pending approval",
	"scope-upgrade": "scope upgrade pending approval",
	"metadata-upgrade": "device metadata change pending approval"
};
function resolveAuthConnectErrorDetailCode(reason) {
	switch (reason) {
		case "token_missing": return ConnectErrorDetailCodes.AUTH_TOKEN_MISSING;
		case "token_mismatch": return ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH;
		case "token_missing_config": return ConnectErrorDetailCodes.AUTH_TOKEN_NOT_CONFIGURED;
		case "password_missing": return ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING;
		case "password_mismatch": return ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH;
		case "password_missing_config": return ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED;
		case "bootstrap_token_invalid": return ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID;
		case "tailscale_user_missing": return ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISSING;
		case "tailscale_proxy_missing": return ConnectErrorDetailCodes.AUTH_TAILSCALE_PROXY_MISSING;
		case "tailscale_whois_failed": return ConnectErrorDetailCodes.AUTH_TAILSCALE_WHOIS_FAILED;
		case "tailscale_user_mismatch": return ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISMATCH;
		case "rate_limited": return ConnectErrorDetailCodes.AUTH_RATE_LIMITED;
		case "device_token_mismatch": return ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH;
		case void 0: return ConnectErrorDetailCodes.AUTH_REQUIRED;
		default: return ConnectErrorDetailCodes.AUTH_UNAUTHORIZED;
	}
}
function resolveDeviceAuthConnectErrorDetailCode(reason) {
	switch (reason) {
		case "device-id-mismatch": return ConnectErrorDetailCodes.DEVICE_AUTH_DEVICE_ID_MISMATCH;
		case "device-signature-stale": return ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_EXPIRED;
		case "device-nonce-missing": return ConnectErrorDetailCodes.DEVICE_AUTH_NONCE_REQUIRED;
		case "device-nonce-mismatch": return ConnectErrorDetailCodes.DEVICE_AUTH_NONCE_MISMATCH;
		case "device-signature": return ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_INVALID;
		case "device-public-key": return ConnectErrorDetailCodes.DEVICE_AUTH_PUBLIC_KEY_INVALID;
		default: return ConnectErrorDetailCodes.DEVICE_AUTH_INVALID;
	}
}
function readConnectErrorDetailCode(details) {
	if (!details || typeof details !== "object" || Array.isArray(details)) return null;
	const code = details.code;
	return typeof code === "string" && code.trim().length > 0 ? code : null;
}
function readConnectErrorRecoveryAdvice(details) {
	if (!details || typeof details !== "object" || Array.isArray(details)) return {};
	const raw = details;
	const canRetryWithDeviceToken = typeof raw.canRetryWithDeviceToken === "boolean" ? raw.canRetryWithDeviceToken : void 0;
	const normalizedNextStep = normalizeOptionalString(raw.recommendedNextStep) ?? "";
	return {
		canRetryWithDeviceToken,
		recommendedNextStep: CONNECT_RECOVERY_NEXT_STEP_VALUES.has(normalizedNextStep) ? normalizedNextStep : void 0
	};
}
function normalizePairingConnectReason(value) {
	const normalized = normalizeOptionalString(value) ?? "";
	return CONNECT_PAIRING_REQUIRED_REASON_VALUES.has(normalized) ? normalized : void 0;
}
function normalizePairingConnectRequestId(value) {
	const normalized = normalizeOptionalString(value);
	return normalized && PAIRING_CONNECT_REQUEST_ID_PATTERN.test(normalized) ? normalized : void 0;
}
function normalizeStringArray(value) {
	if (!Array.isArray(value)) return;
	const normalized = value.map((item) => normalizeOptionalString(item)).filter((item) => Boolean(item));
	return normalized.length > 0 ? normalized : [];
}
function createPairingConnectErrorDetails(params) {
	return {
		code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
		...params.reason ? { reason: params.reason } : {},
		...params.requestId ? { requestId: params.requestId } : {},
		...params.remediationHint ? { remediationHint: params.remediationHint } : {},
		...params.deviceId ? { deviceId: params.deviceId } : {},
		...params.requestedRole ? { requestedRole: params.requestedRole } : {},
		...params.requestedScopes ? { requestedScopes: params.requestedScopes } : {},
		...params.approvedRoles ? { approvedRoles: params.approvedRoles } : {},
		...params.approvedScopes ? { approvedScopes: params.approvedScopes } : {}
	};
}
function describePairingConnectRequirement(reason) {
	return reason ? PAIRING_CONNECT_REASON_METADATA[reason].requirement : "device approval is required";
}
function buildPairingConnectErrorMessage(reason) {
	return reason ? `pairing required: ${describePairingConnectRequirement(reason)}` : "pairing required";
}
function buildPairingConnectRemediationHint(reason) {
	return reason ? PAIRING_CONNECT_REASON_METADATA[reason].remediationHint : "Approve the pending device request before retrying.";
}
function buildPairingConnectRecoveryTitle(reason) {
	return reason ? PAIRING_CONNECT_REASON_METADATA[reason].recoveryTitle : "Gateway pairing approval required.";
}
function buildPairingConnectErrorDetails(params) {
	const requestId = normalizePairingConnectRequestId(params.requestId);
	const remediationHint = normalizeOptionalString(params.remediationHint) ?? buildPairingConnectRemediationHint(params.reason);
	const deviceId = normalizeOptionalString(params.deviceId);
	const requestedRole = normalizeOptionalString(params.requestedRole);
	const requestedScopes = normalizeStringArray(params.requestedScopes);
	const approvedRoles = normalizeStringArray(params.approvedRoles);
	const approvedScopes = normalizeStringArray(params.approvedScopes);
	return createPairingConnectErrorDetails({
		reason: params.reason,
		requestId,
		remediationHint,
		deviceId,
		requestedRole,
		requestedScopes,
		approvedRoles,
		approvedScopes
	});
}
function buildPairingConnectCloseReason(params) {
	const requestId = normalizePairingConnectRequestId(params.requestId);
	const message = buildPairingConnectErrorMessage(params.reason);
	return requestId ? `${message} (requestId: ${requestId})` : message;
}
function readPairingConnectErrorDetails(details) {
	if (readConnectErrorDetailCode(details) !== ConnectErrorDetailCodes.PAIRING_REQUIRED) return null;
	if (!details || typeof details !== "object" || Array.isArray(details)) return null;
	const raw = details;
	const reason = normalizePairingConnectReason(raw.reason);
	return createPairingConnectErrorDetails({
		reason,
		requestId: normalizePairingConnectRequestId(raw.requestId),
		remediationHint: normalizeOptionalString(raw.remediationHint) ?? buildPairingConnectRemediationHint(reason),
		deviceId: normalizeOptionalString(raw.deviceId),
		requestedRole: normalizeOptionalString(raw.requestedRole),
		requestedScopes: normalizeStringArray(raw.requestedScopes),
		approvedRoles: normalizeStringArray(raw.approvedRoles),
		approvedScopes: normalizeStringArray(raw.approvedScopes)
	});
}
function readConnectPairingRequiredMessage(message) {
	const normalizedMessage = normalizeOptionalString(message);
	if (!normalizedMessage) return null;
	const normalized = normalizedMessage.trim().toLowerCase();
	let reason;
	for (const [candidate, prefix] of Object.entries(CONNECT_PAIRING_REQUIRED_MESSAGE_BY_REASON)) if (normalized.includes(prefix)) {
		reason = candidate;
		break;
	}
	if (!reason && normalized.includes("pairing required")) reason = ConnectPairingRequiredReasons.NOT_PAIRED;
	if (!reason) return null;
	const requestId = normalizePairingConnectRequestId(normalizedMessage.match(/\(requestId:\s*([^\s)]+)\)/i)?.[1]);
	return {
		...requestId ? { requestId } : {},
		reason
	};
}
function formatConnectPairingRequiredMessage(details) {
	const pairing = readPairingConnectErrorDetails(details);
	const base = CONNECT_PAIRING_REQUIRED_MESSAGE_BY_REASON[pairing?.reason ?? ConnectPairingRequiredReasons.NOT_PAIRED];
	return pairing?.requestId ? `${base} (requestId: ${pairing.requestId})` : base;
}
function formatConnectErrorMessage(params) {
	if (readConnectErrorDetailCode(params.details) === ConnectErrorDetailCodes.PAIRING_REQUIRED) return formatConnectPairingRequiredMessage(params.details);
	return normalizeOptionalString(params.message) ?? "gateway request failed";
}
//#endregion
export { buildPairingConnectRecoveryTitle as a, normalizePairingConnectRequestId as c, readConnectPairingRequiredMessage as d, readPairingConnectErrorDetails as f, buildPairingConnectErrorMessage as i, readConnectErrorDetailCode as l, resolveDeviceAuthConnectErrorDetailCode as m, buildPairingConnectCloseReason as n, describePairingConnectRequirement as o, resolveAuthConnectErrorDetailCode as p, buildPairingConnectErrorDetails as r, formatConnectErrorMessage as s, ConnectErrorDetailCodes as t, readConnectErrorRecoveryAdvice as u };
