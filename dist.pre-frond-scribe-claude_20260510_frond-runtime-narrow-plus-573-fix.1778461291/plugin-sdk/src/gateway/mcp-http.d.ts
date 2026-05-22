export { createMcpLoopbackServerConfig, getActiveMcpLoopbackRuntime, resolveMcpLoopbackBearerToken, } from "./mcp-http.loopback-runtime.js";
type McpLoopbackServer = {
    port: number;
    close: () => Promise<void>;
};
export declare function startMcpLoopbackServer(port?: number): Promise<{
    port: number;
    close: () => Promise<void>;
}>;
export declare function ensureMcpLoopbackServer(port?: number): Promise<McpLoopbackServer>;
export declare function closeMcpLoopbackServer(): Promise<void>;
