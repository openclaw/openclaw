export type ChatChannelId = string;
export declare const CHAT_CHANNEL_ORDER: readonly string[];
export declare const CHANNEL_IDS: readonly string[];
export declare const CHAT_CHANNEL_ALIASES: Record<string, ChatChannelId>;
export declare function listChatChannelAliases(): string[];
export declare function normalizeChatChannelId(raw?: string | null): ChatChannelId | null;
