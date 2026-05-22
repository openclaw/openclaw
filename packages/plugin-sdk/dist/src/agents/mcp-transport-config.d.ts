import { type HttpMcpTransportType } from "./mcp-http.js";
type ResolvedBaseMcpTransportConfig = {
    description: string;
    connectionTimeoutMs: number;
};
type ResolvedStdioMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
    kind: "stdio";
    transportType: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
};
type ResolvedHttpMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
    kind: "http";
    transportType: HttpMcpTransportType;
    url: string;
    headers?: Record<string, string>;
};
type ResolvedMcpTransportConfig = ResolvedStdioMcpTransportConfig | ResolvedHttpMcpTransportConfig;
export declare function resolveMcpTransportConfig(serverName: string, rawServer: unknown): ResolvedMcpTransportConfig | null;
export {};
