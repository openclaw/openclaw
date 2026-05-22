import type { APIApplicationCommand, APIInteraction } from "discord-api-types/v10";
import { type DeployCommandOptions } from "./command-deploy.js";
import type { BaseCommand } from "./commands.js";
import { BaseMessageInteractiveComponent, parseCustomId, type Modal } from "./components.js";
import { type DiscordEventQueueOptions } from "./event-queue.js";
import { RequestClient, type RequestClientOptions } from "./rest.js";
import type { Guild, GuildMember, Message, User } from "./structures.js";
export interface Route {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: `/${string}`;
    handler(req: Request, ctx?: Context): Response | Promise<Response>;
    protected?: boolean;
    disabled?: boolean;
}
export interface Context {
    waitUntil?(promise: Promise<unknown>): void;
    env?: unknown;
}
export declare abstract class Plugin {
    abstract readonly id: string;
    registerClient?(client: Client): Promise<void> | void;
    registerRoutes?(client: Client): Promise<void> | void;
    onRequest?(req: Request, ctx: Context): Promise<Response | undefined> | Response | undefined;
}
export type AnyListener = {
    type: string;
    handle(data: unknown, client: Client): Promise<void> | void;
};
export interface ClientOptions {
    baseUrl: string;
    clientId: string;
    deploySecret?: string;
    publicKey: string | string[];
    token: string;
    requestOptions?: RequestClientOptions;
    autoDeploy?: boolean;
    disableDeployRoute?: boolean;
    disableInteractionsRoute?: boolean;
    disableEventsRoute?: boolean;
    commandDeployHashStorePath?: string;
    devGuilds?: string[];
    eventQueue?: DiscordEventQueueOptions;
    restCacheTtlMs?: number;
}
type OneOffComponentResult = {
    success: true;
    customId: string;
    message: Message;
    values?: string[];
} | {
    success: false;
    message: Message;
    reason: "timed out";
};
export declare class ComponentRegistry<T extends {
    customId: string;
    customIdParser?: typeof parseCustomId;
    type?: number;
}> {
    private entries;
    private oneOffComponents;
    private wildcardEntries;
    register(entry: T): void;
    resolve(customId: string, options?: {
        componentType?: number;
    }): T | undefined;
    waitForMessageComponent(message: Message, timeoutMs: number): Promise<OneOffComponentResult>;
    resolveOneOffComponent(params: {
        channelId?: string;
        customId: string;
        messageId?: string;
        values?: string[];
    }): boolean;
}
export declare class Client {
    routes: Route[];
    plugins: Array<{
        id: string;
        plugin: Plugin;
    }>;
    options: ClientOptions;
    commands: BaseCommand[];
    listeners: AnyListener[];
    rest: RequestClient;
    componentHandler: ComponentRegistry<BaseMessageInteractiveComponent>;
    private commandDeployer;
    private entityCache;
    private eventQueue?;
    modalHandler: ComponentRegistry<Modal>;
    shardId?: number;
    totalShards?: number;
    constructor(options: ClientOptions, handlers: {
        commands?: BaseCommand[];
        listeners?: AnyListener[];
        components?: BaseMessageInteractiveComponent[];
        modals?: Modal[];
    }, plugins?: Plugin[]);
    getPlugin<T = Plugin>(id: string): T | undefined;
    registerListener(listener: AnyListener): AnyListener;
    unregisterListener(listener: AnyListener): boolean;
    getRuntimeMetrics(): {
        request: {
            globalRateLimitUntil: number;
            activeBuckets: number;
            routeBucketMappings: number;
            buckets: {
                key: string;
                active: number;
                bucket: string | undefined;
                invalidRequests: number;
                pending: number;
                pendingByLane: {
                    [k: string]: number;
                };
                rateLimitHits: number;
                remaining: number | undefined;
                resetAt: number;
                routeKeyCount: number;
            }[];
            invalidRequestCount: number;
            invalidRequestCountByStatus: Record<number, number>;
            queueSize: number;
            queueSizeByLane: {
                background: number;
                critical: number;
                standard: number;
            };
            droppedByLane: {
                background: number;
                critical: number;
                standard: number;
            };
            oldestQueuedByLane: {
                [k: string]: number;
            };
            activeWorkers: number;
            maxConcurrentWorkers: number;
        };
        eventQueue: {
            queueSize: number;
            processing: number;
            processed: number;
            dropped: number;
            timeouts: number;
            maxQueueSize: number;
            maxConcurrency: number;
        } | undefined;
    };
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
    getDiscordCommands(): Promise<APIApplicationCommand[]>;
    deployCommands(options?: DeployCommandOptions): Promise<{
        mode: "overwrite" | "reconcile";
        usedDevGuilds: boolean;
    }>;
    reconcileCommands(): Promise<{
        mode: "overwrite" | "reconcile";
        usedDevGuilds: boolean;
    }>;
    handleInteraction(rawData: APIInteraction, _ctx?: Context): Promise<void>;
    dispatchGatewayEvent(type: string, data: unknown): Promise<void>;
}
export {};
