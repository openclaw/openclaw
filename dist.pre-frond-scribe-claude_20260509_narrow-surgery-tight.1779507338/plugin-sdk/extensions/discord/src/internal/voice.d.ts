import type { DiscordGatewayAdapterCreator, DiscordGatewayAdapterLibraryMethods } from "@discordjs/voice";
import { Plugin, type Client } from "./client.js";
import type { GatewayPlugin } from "./gateway.js";
export declare class VoicePlugin extends Plugin {
    readonly id = "voice";
    protected client?: Client;
    readonly adapters: Map<string, DiscordGatewayAdapterLibraryMethods>;
    private gatewayPlugin?;
    registerClient(client: Client): void;
    getGateway(_guildId: string): GatewayPlugin | undefined;
    getGatewayAdapterCreator(guildId: string): DiscordGatewayAdapterCreator;
}
