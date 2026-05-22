export declare const GATEWAY_STARTUP_UNAVAILABLE_REASON = "startup-sidecars";
export declare const GATEWAY_STARTUP_PENDING_CLOSE_CAUSE = "startup-sidecars-pending";
export declare const GATEWAY_STARTUP_CLOSE_CODE = 1013;
export declare const GATEWAY_STARTUP_CLOSE_REASON = "gateway starting";
export declare const GATEWAY_STARTUP_RETRY_AFTER_MS = 500;
export type GatewayStartupUnavailableDetails = {
    reason: typeof GATEWAY_STARTUP_UNAVAILABLE_REASON;
};
export declare function gatewayStartupUnavailableDetails(): GatewayStartupUnavailableDetails;
export declare function isRetryableGatewayStartupUnavailableError(error: unknown): boolean;
export declare function resolveGatewayStartupRetryAfterMs(error: unknown): number | null;
