export type DecorativeEmojiOptions = {
    env?: NodeJS.ProcessEnv;
    isTty?: boolean;
    platform?: NodeJS.Platform;
    stream?: {
        isTTY?: boolean;
    };
};
export declare function supportsDecorativeEmoji(options?: DecorativeEmojiOptions): boolean;
export declare function decorativeEmoji(emoji: string, options?: DecorativeEmojiOptions): string;
export declare function decorativePrefix(emoji: string, text: string, options?: DecorativeEmojiOptions): string;
export declare function stripDecorativeEmojiForTerminal(text: string, options?: DecorativeEmojiOptions): string;
