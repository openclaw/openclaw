export type GatewayMethodDispatchError = {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
};
export type GatewayMethodDispatchResponse = {
    ok: boolean;
    payload?: unknown;
    error?: GatewayMethodDispatchError;
    meta?: Record<string, unknown>;
};
export type GatewayMethodDispatchOptions = {
    expectFinal?: boolean;
    timeoutMs?: number;
};
/**
 * Dispatch a Gateway control-plane method from an authenticated plugin request scope.
 */
export declare function dispatchGatewayMethod(method: string, params?: unknown, options?: GatewayMethodDispatchOptions): Promise<GatewayMethodDispatchResponse>;
