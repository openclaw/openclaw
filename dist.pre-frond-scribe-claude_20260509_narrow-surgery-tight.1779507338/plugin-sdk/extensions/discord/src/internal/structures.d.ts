import { type APIChannel, type APIEmbed, type APIGuild, type APIGuildMember, type APIMessage, type APIRole, type APIUser, type MessageType } from "discord-api-types/v10";
import { type MessagePayload } from "./payload.js";
import type { RequestClient } from "./rest.js";
type RawOrId<T> = T | string | {
    id: string;
    channelId?: string;
};
export type StructureClient = {
    rest: RequestClient;
    fetchUser(id: string): Promise<User>;
};
export declare class Base {
    protected client: StructureClient;
    constructor(client: StructureClient);
}
export declare class User<IsPartial extends boolean = false> extends Base {
    protected rawDataValue: APIUser | null;
    readonly id: string;
    constructor(client: StructureClient, rawDataOrId: IsPartial extends true ? string : APIUser);
    get rawData(): Readonly<APIUser>;
    get partial(): IsPartial;
    get username(): string;
    get globalName(): string | null | undefined;
    get discriminator(): string | undefined;
    get bot(): boolean | undefined;
    get avatar(): string | null | undefined;
    get avatarUrl(): string | null;
    toString(): string;
    fetch(): Promise<User>;
    createDm(): Promise<Pick<APIChannel, "id">>;
    send(data: MessagePayload): Promise<Message>;
}
export declare class Role<IsPartial extends boolean = false> extends Base {
    protected rawDataValue: APIRole | null;
    readonly id: string;
    constructor(client: StructureClient, rawDataOrId: IsPartial extends true ? string : APIRole);
    get name(): string;
}
export declare class Guild<IsPartial extends boolean = false> extends Base {
    protected rawDataValue: APIGuild | null;
    readonly id: string;
    constructor(client: StructureClient, rawDataOrId: IsPartial extends true ? string : APIGuild);
    get name(): string;
}
export declare class GuildMember extends Base {
    rawData: APIGuildMember;
    constructor(client: StructureClient, rawData: APIGuildMember);
    get user(): User<false> | null;
    get roles(): Array<string | Role>;
    get nickname(): string | undefined;
}
export declare class Message<IsPartial extends boolean = false> extends Base {
    protected rawDataValue: APIMessage | null;
    readonly id: string;
    readonly channelId: string;
    constructor(client: StructureClient, rawDataOrIds: RawOrId<APIMessage>);
    get rawData(): Readonly<APIMessage>;
    get partial(): IsPartial;
    get message(): Message<IsPartial>;
    get channel_id(): string;
    get guild_id(): string | undefined;
    get guild(): Guild<true> | null;
    get webhookId(): string | null;
    get webhook_id(): string | null;
    get member(): GuildMember | null;
    get rawMember(): APIGuildMember | undefined;
    get content(): string;
    get author(): User<false> | null;
    get embeds(): APIEmbed[];
    get attachments(): import("discord-api-types/v10").APIAttachment[];
    get stickers(): import("discord-api-types/v10").APIStickerItem[];
    get mentionedUsers(): User<false>[];
    get mentionedRoles(): string[];
    get mentionedEveryone(): boolean;
    get timestamp(): string | undefined;
    get type(): MessageType | undefined;
    get messageReference(): import("discord-api-types/v10").APIMessageReference | undefined;
    get referencedMessage(): Message<false> | null;
    get thread(): (import("discord-api-types/v10").APIAnnouncementThreadChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGroupDMChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildCategoryChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildForumChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildMediaChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildStageVoiceChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIGuildVoiceChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APINewsChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIPrivateThreadChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APIPublicThreadChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | (import("discord-api-types/v10").APITextChannel & {
        rawData?: APIChannel;
        guildId?: string;
        guild?: Guild;
        name?: string;
        parentId?: string | null;
        ownerId?: string | null;
    }) | null;
    fetch(): Promise<Message>;
    delete(): Promise<void>;
    edit(data: MessagePayload): Promise<Message>;
    reply(data: MessagePayload): Promise<Message>;
    pin(): Promise<void>;
    unpin(): Promise<void>;
}
export type DiscordChannel = APIChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
};
export declare function channelFactory(clientForTest: StructureClient, channelData: APIChannel, _partial?: boolean): DiscordChannel;
export {};
