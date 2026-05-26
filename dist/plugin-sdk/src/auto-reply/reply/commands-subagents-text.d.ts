export type ChatMessage = {
    role?: unknown;
    content?: unknown;
};
export declare function extractMessageText(message: ChatMessage): {
    role: string;
    text: string;
} | null;
