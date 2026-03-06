import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { browserAct } from "../../browser/client-actions.js";
type BrowserProxyRequest = (opts: {
    method: string;
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    timeoutMs?: number;
    profile?: string;
}) => Promise<unknown>;
export declare function executeTabsAction(params: {
    baseUrl?: string;
    profile?: string;
    proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>>;
export declare function executeSnapshotAction(params: {
    input: Record<string, unknown>;
    baseUrl?: string;
    profile?: string;
    proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>>;
export declare function executeConsoleAction(params: {
    input: Record<string, unknown>;
    baseUrl?: string;
    profile?: string;
    proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>>;
export declare function executeActAction(params: {
    request: Parameters<typeof browserAct>[1];
    baseUrl?: string;
    profile?: string;
    proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>>;
export {};
