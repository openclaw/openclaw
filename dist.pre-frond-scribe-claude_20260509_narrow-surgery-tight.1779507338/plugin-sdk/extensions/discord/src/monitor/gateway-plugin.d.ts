import * as httpsProxyAgent from "https-proxy-agent";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import * as ws from "ws";
import * as discordGateway from "../internal/gateway.js";
export { parseDiscordGatewayInfoBody, resolveDiscordGatewayInfoTimeoutMs, } from "./gateway-metadata.js";
type DiscordGatewayWebSocketCtor = new (url: string, options?: {
    agent?: unknown;
    handshakeTimeout?: number;
}) => ws.WebSocket;
type DiscordGatewayClient = Parameters<discordGateway.GatewayPlugin["registerClient"]>[0];
type GatewayPluginTestingOptions = {
    registerClient?: (plugin: discordGateway.GatewayPlugin, client: DiscordGatewayClient) => Promise<void>;
    webSocketCtor?: DiscordGatewayWebSocketCtor;
};
type CreateDiscordGatewayPluginTestingOptions = GatewayPluginTestingOptions & {
    HttpsProxyAgentCtor?: typeof httpsProxyAgent.HttpsProxyAgent;
};
type ResolveDiscordGatewayIntentsParams = {
    intentsConfig?: import("openclaw/plugin-sdk/config-contracts").DiscordIntentsConfig;
    voiceEnabled?: boolean;
};
export declare function resolveDiscordGatewayIntents(params?: ResolveDiscordGatewayIntentsParams): number;
export declare function waitForDiscordGatewayPluginRegistration(plugin: unknown): Promise<void> | undefined;
export declare function createDiscordGatewayPlugin(params: {
    discordConfig: DiscordAccountConfig;
    runtime: RuntimeEnv;
    testing?: CreateDiscordGatewayPluginTestingOptions;
}): discordGateway.GatewayPlugin;
