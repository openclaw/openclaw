import type { RequestQuery } from "./rest-scheduler.js";
import type { RequestClient } from "./rest.js";
export declare function createOwnMessageReaction(rest: RequestClient, channelId: string, messageId: string, encodedEmoji: string): Promise<void>;
export declare function deleteOwnMessageReaction(rest: RequestClient, channelId: string, messageId: string, encodedEmoji: string): Promise<void>;
export declare function listMessageReactionUsers(rest: RequestClient, channelId: string, messageId: string, encodedEmoji: string, query?: RequestQuery): Promise<Array<{
    id: string;
    username?: string;
    discriminator?: string;
}>>;
