import { type RetryOptions, type WebClientOptions, WebClient } from "@slack/web-api";
export declare const SLACK_DEFAULT_RETRY_OPTIONS: RetryOptions;
export declare function resolveSlackWebClientOptions(options?: WebClientOptions): WebClientOptions;
export declare function createSlackWebClient(token: string, options?: WebClientOptions): WebClient;
