import { type RetryOptions, type WebClientOptions, WebClient } from "@slack/web-api";
import { HttpsProxyAgent } from "https-proxy-agent";

export const SLACK_DEFAULT_RETRY_OPTIONS: RetryOptions = {
  retries: 2,
  factor: 2,
  minTimeout: 500,
  maxTimeout: 3000,
  randomize: true,
};

export const SLACK_WRITE_RETRY_OPTIONS: RetryOptions = {
  retries: 0,
};

/**
 * Build an HTTPS proxy agent from env vars (HTTPS_PROXY, HTTP_PROXY, etc.)
 * for use as the `agent` option in Slack WebClient and Socket Mode connections.
 *
 * When set, this agent is forwarded through @slack/bolt → @slack/socket-mode →
 * SlackWebSocket as the `httpAgent`, which the `ws` library uses to tunnel the
 * WebSocket upgrade request through the proxy.  This fixes Socket Mode in
 * environments where outbound traffic must go through an HTTP CONNECT proxy.
 *
 * Returns `undefined` when no proxy env var is configured.
 */
function resolveSlackProxyAgent(): HttpsProxyAgent<string> | undefined {
  // Match undici EnvHttpProxyAgent semantics: lower-case takes precedence,
  // HTTPS prefers https_proxy then falls back to http_proxy.
  const proxyUrl =
    process.env.https_proxy?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    undefined;
  if (!proxyUrl) {
    return undefined;
  }
  return new HttpsProxyAgent<string>(proxyUrl);
}

export function resolveSlackWebClientOptions(options: WebClientOptions = {}): WebClientOptions {
  return {
    ...options,
    agent: options.agent ?? resolveSlackProxyAgent(),
    retryConfig: options.retryConfig ?? SLACK_DEFAULT_RETRY_OPTIONS,
  };
}

export function resolveSlackWriteClientOptions(options: WebClientOptions = {}): WebClientOptions {
  return {
    ...options,
    agent: options.agent ?? resolveSlackProxyAgent(),
    retryConfig: options.retryConfig ?? SLACK_WRITE_RETRY_OPTIONS,
  };
}

export function createSlackWebClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, resolveSlackWebClientOptions(options));
}

export function createSlackWriteClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, resolveSlackWriteClientOptions(options));
}
