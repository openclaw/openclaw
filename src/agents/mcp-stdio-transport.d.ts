import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
export type OpenClawStdioServerParameters = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stderr?: "pipe" | "overlapped" | "inherit" | "ignore";
};
export declare class OpenClawStdioClientTransport implements Transport {
    private readonly serverParams;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    private readonly readBuffer;
    private readonly stderrStream;
    private process?;
    constructor(serverParams: OpenClawStdioServerParameters);
    start(): Promise<void>;
    get stderr(): import("node:stream").Readable | null;
    get pid(): number | null;
    private processReadBuffer;
    close(): Promise<void>;
    send(message: JSONRPCMessage): Promise<void>;
}
