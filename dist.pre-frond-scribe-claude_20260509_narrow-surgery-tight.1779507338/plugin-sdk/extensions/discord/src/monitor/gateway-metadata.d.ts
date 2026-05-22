import type { APIGatewayBotInfo } from "discord-api-types/v10";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
type DiscordGatewayMetadataResponse = Pick<Response, "ok" | "status" | "text">;
export type DiscordGatewayFetchInit = Record<string, unknown> & {
    headers?: Record<string, string>;
};
export type DiscordGatewayFetch = (input: string, init?: DiscordGatewayFetchInit) => Promise<DiscordGatewayMetadataResponse>;
export declare function resolveDiscordGatewayInfoTimeoutMs(params?: {
    configuredTimeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}): number;
export declare function parseDiscordGatewayInfoBody(body: string): APIGatewayBotInfo;
export declare function fetchDiscordGatewayInfo(params: {
    token: string;
    fetchImpl: DiscordGatewayFetch;
    fetchInit?: DiscordGatewayFetchInit;
}): Promise<APIGatewayBotInfo>;
export declare function fetchDiscordGatewayInfoWithTimeout(params: {
    token: string;
    fetchImpl: DiscordGatewayFetch;
    fetchInit?: DiscordGatewayFetchInit;
    timeoutMs?: number;
}): Promise<APIGatewayBotInfo>;
export declare function resolveGatewayInfoWithFallback(params: {
    runtime?: RuntimeEnv;
    error: unknown;
}): {
    info: APIGatewayBotInfo;
    usedFallback: boolean;
};
export declare function fetchDiscordGatewayMetadataDirect(input: string, init?: DiscordGatewayFetchInit, capture?: false | {
    flowId: string;
    meta: Record<string, unknown>;
}): Promise<Response>;
export {};
