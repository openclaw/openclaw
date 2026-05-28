//#region packages/gateway-protocol/src/startup-unavailable.ts
const GATEWAY_STARTUP_UNAVAILABLE_REASON = "startup-sidecars";
const GATEWAY_STARTUP_PENDING_CLOSE_CAUSE = "startup-sidecars-pending";
const GATEWAY_STARTUP_CLOSE_CODE = 1013;
const GATEWAY_STARTUP_CLOSE_REASON = "gateway starting";
const GATEWAY_STARTUP_RETRY_AFTER_MS = 500;
const GATEWAY_STARTUP_RETRY_MIN_MS = 100;
const GATEWAY_STARTUP_RETRY_MAX_MS = 2e3;
function gatewayStartupUnavailableDetails() {
	return { reason: GATEWAY_STARTUP_UNAVAILABLE_REASON };
}
function isGatewayStartupUnavailableDetails(details) {
	return typeof details === "object" && details !== null && details.reason === "startup-sidecars";
}
function isRetryableGatewayStartupUnavailableError(error) {
	if (!error || typeof error !== "object") return false;
	const shaped = error;
	return (shaped.gatewayCode ?? shaped.code) === "UNAVAILABLE" && shaped.retryable === true && isGatewayStartupUnavailableDetails(shaped.details);
}
function resolveGatewayStartupRetryAfterMs(error) {
	if (!isRetryableGatewayStartupUnavailableError(error)) return null;
	const retryAfterMs = error.retryAfterMs;
	return Math.min(Math.max(Math.floor(typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? retryAfterMs : 500), GATEWAY_STARTUP_RETRY_MIN_MS), GATEWAY_STARTUP_RETRY_MAX_MS);
}
//#endregion
export { GATEWAY_STARTUP_CLOSE_CODE, GATEWAY_STARTUP_CLOSE_REASON, GATEWAY_STARTUP_PENDING_CLOSE_CAUSE, GATEWAY_STARTUP_RETRY_AFTER_MS, GATEWAY_STARTUP_UNAVAILABLE_REASON, gatewayStartupUnavailableDetails, isRetryableGatewayStartupUnavailableError, resolveGatewayStartupRetryAfterMs };
