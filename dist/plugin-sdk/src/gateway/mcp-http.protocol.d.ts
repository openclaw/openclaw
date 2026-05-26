export declare const MCP_LOOPBACK_SERVER_NAME = "openclaw";
export declare const MCP_LOOPBACK_SERVER_VERSION = "0.1.0";
export declare const MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS: readonly ["2025-03-26", "2024-11-05"];
type JsonRpcId = string | number | null | undefined;
export type JsonRpcRequest = {
    jsonrpc: "2.0";
    id?: JsonRpcId;
    method: string;
    params?: Record<string, unknown>;
};
export declare function jsonRpcResult(id: JsonRpcId, result: unknown): {
    jsonrpc: "2.0";
    id: string | number | null;
    result: unknown;
};
export declare function jsonRpcError(id: JsonRpcId, code: number, message: string): {
    jsonrpc: "2.0";
    id: string | number | null;
    error: {
        code: number;
        message: string;
    };
};
export {};
