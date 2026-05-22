import { type WebClientOptions, WebClient } from "@slack/web-api";
export { resolveSlackWebClientOptions, resolveSlackWriteClientOptions, SLACK_DEFAULT_RETRY_OPTIONS, SLACK_WRITE_RETRY_OPTIONS, } from "./client-options.js";
export declare function createSlackWebClient(token: string, options?: WebClientOptions): WebClient;
export declare function createSlackWriteClient(token: string, options?: WebClientOptions): WebClient;
export declare function createSlackTokenCacheKey(token: string): string;
export declare function getSlackWriteClient(token: string): WebClient;
export declare function clearSlackWriteClientCacheForTest(): void;
