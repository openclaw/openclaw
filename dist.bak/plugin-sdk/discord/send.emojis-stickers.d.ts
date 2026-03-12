import type { DiscordEmojiUpload, DiscordReactOpts, DiscordStickerUpload } from "./send.types.js";
export declare function listGuildEmojisDiscord(guildId: string, opts?: DiscordReactOpts): Promise<unknown>;
export declare function uploadEmojiDiscord(payload: DiscordEmojiUpload, opts?: DiscordReactOpts): Promise<unknown>;
export declare function uploadStickerDiscord(payload: DiscordStickerUpload, opts?: DiscordReactOpts): Promise<unknown>;
