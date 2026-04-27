export type HttpMcpTransportType = "sse" | "streamable-http";
export type HttpMcpServerLaunchConfig = {
    transportType: HttpMcpTransportType;
    url: string;
    headers?: Record<string, string>;
};
export type HttpMcpServerLaunchResult = {
    ok: true;
    config: HttpMcpServerLaunchConfig;
} | {
    ok: false;
    reason: string;
};
export declare function resolveHttpMcpServerLaunchConfig(raw: unknown, options?: {
    transportType?: HttpMcpTransportType;
    onDroppedHeader?: (key: string, value: unknown) => void;
    onMalformedHeaders?: (value: unknown) => void;
}): HttpMcpServerLaunchResult;
export declare function describeHttpMcpServerLaunchConfig(config: HttpMcpServerLaunchConfig): string;
