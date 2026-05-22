import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
type ResolvedMcpTransport = {
    transport: Transport;
    description: string;
    transportType: "stdio" | "sse" | "streamable-http";
    connectionTimeoutMs: number;
    detachStderr?: () => void;
};
export declare function resolveMcpTransport(serverName: string, rawServer: unknown): ResolvedMcpTransport | null;
export {};
