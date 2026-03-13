export type MessagingToolSend = {
    tool: string;
    provider: string;
    accountId?: string;
    to?: string;
    threadId?: string;
};
export declare function isMessagingTool(toolName: string): boolean;
export declare function isMessagingToolSendAction(toolName: string, args: Record<string, unknown>): boolean;
