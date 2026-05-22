import { RequestClient, type RequestClientOptions } from "./internal/discord.js";
type ProxyRequestClientOptions = RequestClientOptions;
export declare const DISCORD_REST_TIMEOUT_MS = 15000;
export declare function createDiscordRequestClient(token: string, options?: ProxyRequestClientOptions): RequestClient;
export {};
