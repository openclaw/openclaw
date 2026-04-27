export type { MessagingToolSend } from "./pi-embedded-messaging.types.js";
export declare function isMessagingTool(toolName: string): boolean;
export declare function isMessagingToolSendAction(toolName: string, args: Record<string, unknown>): boolean;
