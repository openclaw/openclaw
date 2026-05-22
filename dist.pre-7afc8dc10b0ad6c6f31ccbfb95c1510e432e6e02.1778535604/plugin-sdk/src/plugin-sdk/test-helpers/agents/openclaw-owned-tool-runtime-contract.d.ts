import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CodexAppServerToolResultEvent } from "../../../plugins/codex-app-server-extension-types.js";
export declare function textToolResult(text: string, details?: Record<string, unknown>): AgentToolResult<unknown>;
export declare function mediaToolResult(text: string, mediaUrl: string, audioAsVoice?: boolean): AgentToolResult<unknown>;
export declare function installOpenClawOwnedToolHooks(params?: {
    adjustedParams?: Record<string, unknown>;
    blockReason?: string;
}): {
    beforeToolCall: import("vitest").Mock<() => Promise<{
        block: boolean;
        blockReason: string;
        params?: undefined;
    } | {
        block?: undefined;
        blockReason?: undefined;
        params: Record<string, unknown>;
    } | {
        block?: undefined;
        blockReason?: undefined;
        params?: undefined;
    }>>;
    afterToolCall: import("vitest").Mock<() => Promise<void>>;
};
/**
 * Installs only the Codex app-server `tool_result` middleware fixture.
 * Pair with `installOpenClawOwnedToolHooks()` when a test asserts before/after hook behavior.
 */
export declare function installCodexToolResultMiddleware(handler: (event: CodexAppServerToolResultEvent) => AgentToolResult<unknown>): {
    middleware: import("vitest").Mock<(event: CodexAppServerToolResultEvent) => Promise<{
        result: AgentToolResult<unknown>;
    }>>;
};
export declare function resetOpenClawOwnedToolHooks(): void;
