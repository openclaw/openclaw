export type ChatType = "direct" | "group" | "channel";
export declare function normalizeChatType(raw?: string): ChatType | undefined;
