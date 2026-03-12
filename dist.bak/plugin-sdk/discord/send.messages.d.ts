import type { APIMessage } from "discord-api-types/v10";
import type { DiscordMessageEdit, DiscordMessageQuery, DiscordReactOpts, DiscordSearchQuery, DiscordThreadCreate, DiscordThreadList } from "./send.types.js";
export declare function readMessagesDiscord(channelId: string, query?: DiscordMessageQuery, opts?: DiscordReactOpts): Promise<APIMessage[]>;
export declare function fetchMessageDiscord(channelId: string, messageId: string, opts?: DiscordReactOpts): Promise<APIMessage>;
export declare function editMessageDiscord(channelId: string, messageId: string, payload: DiscordMessageEdit, opts?: DiscordReactOpts): Promise<APIMessage>;
export declare function deleteMessageDiscord(channelId: string, messageId: string, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
export declare function pinMessageDiscord(channelId: string, messageId: string, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
export declare function unpinMessageDiscord(channelId: string, messageId: string, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
export declare function listPinsDiscord(channelId: string, opts?: DiscordReactOpts): Promise<APIMessage[]>;
export declare function createThreadDiscord(channelId: string, payload: DiscordThreadCreate, opts?: DiscordReactOpts): Promise<{
    id: string;
}>;
export declare function listThreadsDiscord(payload: DiscordThreadList, opts?: DiscordReactOpts): Promise<unknown>;
export declare function searchMessagesDiscord(query: DiscordSearchQuery, opts?: DiscordReactOpts): Promise<unknown>;
