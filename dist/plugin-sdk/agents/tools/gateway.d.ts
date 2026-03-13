export declare const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
export type GatewayCallOptions = {
    gatewayUrl?: string;
    gatewayToken?: string;
    timeoutMs?: number;
};
export declare function readGatewayCallOptions(params: Record<string, unknown>): GatewayCallOptions;
export declare function resolveGatewayOptions(opts?: GatewayCallOptions): {
    url: string | undefined;
    token: string | undefined;
    timeoutMs: number;
};
export declare function callGatewayTool<T = Record<string, unknown>>(method: string, opts: GatewayCallOptions, params?: unknown, extra?: {
    expectFinal?: boolean;
}): Promise<T>;
