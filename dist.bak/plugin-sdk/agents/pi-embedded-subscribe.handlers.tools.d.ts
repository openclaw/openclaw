import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { ToolHandlerContext } from "./pi-embedded-subscribe.handlers.types.js";
export declare function handleToolExecutionStart(ctx: ToolHandlerContext, evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    args: unknown;
}): Promise<void>;
export declare function handleToolExecutionUpdate(ctx: ToolHandlerContext, evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
}): void;
export declare function handleToolExecutionEnd(ctx: ToolHandlerContext, evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    isError: boolean;
    result?: unknown;
}): Promise<void>;
