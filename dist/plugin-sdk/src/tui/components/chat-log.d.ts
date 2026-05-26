import { Container } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "./assistant-message.js";
import { BtwInlineMessage } from "./btw-inline-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";
export declare class ChatLog extends Container {
    private readonly maxComponents;
    private toolById;
    private streamingRuns;
    private pendingUsers;
    private pendingSystemNotices;
    private btwMessage;
    private toolsExpanded;
    private repeatableSystemMessage;
    constructor(maxComponents?: number);
    private dropComponentReferences;
    private pruneOverflow;
    private append;
    private appendNonSystem;
    clearAll(opts?: {
        preservePendingUsers?: boolean;
    }): void;
    restorePendingUsers(): void;
    clearPendingUsers(): void;
    private formatRepeatedSystemText;
    private createSystemMessage;
    addSystem(text: string, opts?: {
        coalesceConsecutive?: boolean;
    }): void;
    addPendingSystem(runId: string, text: string): void;
    dismissPendingSystem(runId: string): boolean;
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
