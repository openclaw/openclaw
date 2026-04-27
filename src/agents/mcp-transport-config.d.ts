import { type HttpMcpTransportType } from "./mcp-http.js";
type ResolvedBaseMcpTransportConfig = {
    description: string;
    connectionTimeoutMs: number;
};
export type ResolvedStdioMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
    kind: "stdio";
    transportType: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
};
export type ResolvedHttpMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
    kind: "http";
    transportType: HttpMcpTransportType;
    url: string;
    headers?: Record<string, string>;
};
export type ResolvedMcpTransportConfig = ResolvedStdioMcpTransportConfig | ResolvedHttpMcpTransportConfig;
export declare function resolveMcpTransportConfig(serverName: string, rawServer: unknown): ResolvedMcpTransportConfig | null;
export {};
