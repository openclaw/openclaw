import type { RequestClient } from "./rest.js";
import { Guild, GuildMember, User, type StructureClient } from "./structures.js";
export declare class DiscordEntityCache {
    private readonly params;
    private readonly entries;
    constructor(params: {
        client: StructureClient;
        rest: RequestClient | (() => RequestClient);
        ttlMs?: number;
    });
    fetchUser(id: string): Promise<User>;
    fetchChannel(id: string): Promise<(import("discord-api-types/v10").APIAnnouncementThreadChannel & {
        rawData?: import("discord-api-types/v10").APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGroupDMChannel & {
        rawData?: import("discord-api-types/v10").APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildCategoryChannel & {
        rawData?: import("discord-api-types/v10").APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildForumChannel & {
        rawData?: import("discord-api-types/v10").APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildMediaChannel & {
        rawData?: import("discord-api-types/v10").APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildStageVoiceChannel & {
        rawData?: import("discord-api-types/v10").APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildVoiceChannel & {
        rawData?: import("discord-api-types/v10").APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APINewsChannel & {
        rawData?: import("discord-api-types/v10").APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIPrivateThreadChannel & {
        rawData?: import("discord-api-types/v10").APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIPublicThreadChannel & {
        rawData?: import("discord-api-types/v10").APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APITextChannel & {
        rawData?: import("discord-api-types/v10").APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    })>;
    fetchGuild(id: string): Promise<Guild>;
    fetchMember(guildId: string, userId: string): Promise<GuildMember>;
    invalidateForGatewayEvent(type: string, data: unknown): void;
    private deleteId;
    private fetchCached;
    private get rest();
}
