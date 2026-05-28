//#region packages/gateway-protocol/src/startup-unavailable.d.ts
declare const GATEWAY_STARTUP_UNAVAILABLE_REASON = "startup-sidecars";
declare const GATEWAY_STARTUP_PENDING_CLOSE_CAUSE = "startup-sidecars-pending";
declare const GATEWAY_STARTUP_CLOSE_CODE = 1013;
declare const GATEWAY_STARTUP_CLOSE_REASON = "gateway starting";
declare const GATEWAY_STARTUP_RETRY_AFTER_MS = 500;
type GatewayStartupUnavailableDetails = {
  reason: typeof GATEWAY_STARTUP_UNAVAILABLE_REASON;
};
declare function gatewayStartupUnavailableDetails(): GatewayStartupUnavailableDetails;
declare function isRetryableGatewayStartupUnavailableError(error: unknown): boolean;
declare function resolveGatewayStartupRetryAfterMs(error: unknown): number | null;
//#endregion
export { GATEWAY_STARTUP_CLOSE_CODE, GATEWAY_STARTUP_CLOSE_REASON, GATEWAY_STARTUP_PENDING_CLOSE_CAUSE, GATEWAY_STARTUP_RETRY_AFTER_MS, GATEWAY_STARTUP_UNAVAILABLE_REASON, GatewayStartupUnavailableDetails, gatewayStartupUnavailableDetails, isRetryableGatewayStartupUnavailableError, resolveGatewayStartupRetryAfterMs };