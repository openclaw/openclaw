import type { RetryOptions, WebClientOptions } from "@slack/web-api";
export declare const SLACK_DEFAULT_RETRY_OPTIONS: RetryOptions;
export declare const SLACK_WRITE_RETRY_OPTIONS: RetryOptions;
export declare function resolveSlackWebClientOptions(options?: WebClientOptions): WebClientOptions;
export declare function resolveSlackWriteClientOptions(options?: WebClientOptions): WebClientOptions;
