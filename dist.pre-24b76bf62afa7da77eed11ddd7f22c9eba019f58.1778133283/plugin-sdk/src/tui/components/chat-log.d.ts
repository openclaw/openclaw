import { Container } from "@mariozechner/pi-tui";
import { AssistantMessageComponent } from "./assistant-message.js";
import { BtwInlineMessage } from "./btw-inline-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";
export declare class ChatLog extends Container {
    private readonly maxComponents;
    private toolById;
    private streamingRuns;
    private pendingUsers;
    private btwMessage;
    private toolsExpanded;
    constructor(maxComponents?: number);
    private dropComponentReferences;
    private pruneOverflow;
    private append;
    clearAll(opts?: {
        preservePendingUsers?: boolean;
    }): void;
    restorePendingUsers(): void;
    clearPendingUsers(): void;
    private createSystemMessage;
    addSystem(text: string): void;
    addUser(text: string): void;
    addPendingUser(runId: string, text: string, createdAt?: number): UserMessageComponent;
    commitPendingUser(runId: string): boolean;
    dropPendingUser(runId: string): boolean;
    hasPendingUser(runId: string): boolean;
    reconcilePendingUsers(historyUsers: Array<{
        text: string;
        timestamp?: number | null;
    }>): string[];
    countPendingUsers(): number;
    private resolveRunId;
    startAssistant(text: string, runId?: string): AssistantMessageComponent;
    updateAssistant(text: string, runId?: string): void;
    finalizeAssistant(text: string, runId?: string): void;
    dropAssistant(runId?: string): void;
    showBtw(params: {
        question: string;
        text: string;
        isError?: boolean;
    }): BtwInlineMessage;
    dismissBtw(): void;
    hasVisibleBtw(): boolean;
    startTool(toolCallId: string, toolName: string, args: unknown): ToolExecutionComponent;
    updateToolArgs(toolCallId: string, args: unknown): void;
    updateToolResult(toolCallId: string, result: unknown, opts?: {
        isError?: boolean;
        partial?: boolean;
    }): void;
    setToolsExpanded(expanded: boolean): void;
}
