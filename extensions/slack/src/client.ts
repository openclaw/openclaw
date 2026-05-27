import { type RetryOptions, type WebClientOptions, WebClient } from "@slack/web-api";

export const SLACK_DEFAULT_RETRY_OPTIONS: RetryOptions = {
  retries: 2,
  factor: 2,
  minTimeout: 500,
  maxTimeout: 3000,
  randomize: true,
};

export function resolveSlackWebClientOptions(options: WebClientOptions = {}): WebClientOptions {
  return {
    ...options,
    retryConfig: options.retryConfig ?? SLACK_DEFAULT_RETRY_OPTIONS,
  };
}

export function createSlackWebClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, resolveSlackWebClientOptions(options));
}
