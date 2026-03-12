export declare function resolveRelayAcceptedTokensForPort(port: number): string[];
export declare function resolveRelayAuthTokenForPort(port: number): string;
export declare function probeAuthenticatedOpenClawRelay(params: {
    baseUrl: string;
    relayAuthHeader: string;
    relayAuthToken: string;
    timeoutMs?: number;
}): Promise<boolean>;
