export type { ChannelToolSend } from "../channels/plugins/types.public.js";
/** Extract the canonical send target fields from tool arguments when the action matches. */
export declare function extractToolSend(args: Record<string, unknown>, expectedAction?: string): {
    to: string;
    accountId?: string;
    threadId?: string;
} | null;
