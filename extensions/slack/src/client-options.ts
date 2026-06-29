// Slack plugin module implements client options behavior.
import type { Agent } from "node:http";
import type { RetryOptions, WebClientOptions } from "@slack/web-api";
import { createNodeProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";

export type SlackClientOptions = Omit<WebClientOptions, "slackApiUrl">;

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
 * When set, this agent is forwarded through @slack/bolt -> @slack/socket-mode ->
 * SlackWebSocket as the `httpAgent`, which the `ws` library uses to tunnel the
 * WebSocket upgrade request through the proxy. This fixes Socket Mode in
 * environments where outbound traffic must go through an HTTP CONNECT proxy.
 *
 * Respects `NO_PROXY` / `no_proxy`; if `*.slack.com` (or a matching pattern)
 * appears in the exclusion list, returns `undefined` so the connection is direct.
 *
 * Returns `undefined` when no proxy env var is configured or when Slack hosts
 * are excluded by `NO_PROXY`.
 */
function resolveSlackProxyAgent(targetUrl: string): Agent | undefined {
  try {
    return createNodeProxyAgent({
      mode: "env",
      targetUrl,
    });
  } catch {
    // Malformed proxy URL; degrade gracefully to direct connection.
    return undefined;
  }
}

function resolveSlackApiUrlFromEnv(): string | undefined {
  return process.env.SLACK_API_URL?.trim() || undefined;
}

function resolveSlackClientOptions(
  options: SlackClientOptions,
  defaults: {
    retryConfig: RetryOptions;
    maxRequestConcurrency?: number;
  },
): WebClientOptions {
  const slackApiUrl = resolveSlackApiUrlFromEnv();
  const proxyTargetUrl = slackApiUrl ?? "https://slack.com/";
  const resolved: WebClientOptions = Object.assign({}, options);
  resolved.agent ??= resolveSlackProxyAgent(proxyTargetUrl);
  resolved.retryConfig ??= defaults.retryConfig;
  if (defaults.maxRequestConcurrency !== undefined) {
    resolved.maxRequestConcurrency ??= defaults.maxRequestConcurrency;
  }
  if (slackApiUrl) {
    resolved.slackApiUrl = slackApiUrl;
  } else {
    delete resolved.slackApiUrl;
  }
  return resolved;
}

export function resolveSlackWebClientOptions(options: SlackClientOptions = {}): WebClientOptions {
  return resolveSlackClientOptions(options, { retryConfig: SLACK_DEFAULT_RETRY_OPTIONS });
}

export function resolveSlackWriteClientOptions(options: SlackClientOptions = {}): WebClientOptions {
  return resolveSlackClientOptions(options, {
    retryConfig: SLACK_WRITE_RETRY_OPTIONS,
    maxRequestConcurrency: 1,
  });
}
