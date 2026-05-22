import { type APIApplicationCommandInteractionDataBasicOption, type APIApplicationCommandInteractionDataOption, type APIChannel, type APIInteractionDataResolvedChannel } from "discord-api-types/v10";
import { type DiscordChannel, type StructureClient } from "./structures.js";
type OptionsClient = StructureClient & {
    fetchChannel(id: string): Promise<DiscordChannel>;
};
export declare class OptionsHandler {
    private rawOptions;
    private client;
    private resolvedChannels;
    constructor(rawOptions: APIApplicationCommandInteractionDataOption[] | undefined, client: OptionsClient, resolvedChannels: Record<string, APIInteractionDataResolvedChannel> | undefined);
    getString(name: string): string | null;
    getNumber(name: string): number | null;
    getBoolean(name: string): boolean | null;
    getChannel(name: string, required?: boolean): Promise<(import("discord-api-types/v10").APIAnnouncementThreadChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: import("./structures.js").Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGroupDMChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: import("./structures.js").Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildCategoryChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: import("./structures.js").Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildForumChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: import("./structures.js").Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildMediaChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: import("./structures.js").Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildStageVoiceChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: import("./structures.js").Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildVoiceChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: import("./structures.js").Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APINewsChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: import("./structures.js").Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIPrivateThreadChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: import("./structures.js").Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIPublicThreadChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: import("./structures.js").Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APITextChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: import("./structures.js").Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | null>;
    getFocused(): APIApplicationCommandInteractionDataBasicOption | undefined;
}
export {};
