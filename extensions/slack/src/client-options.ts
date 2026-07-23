// Slack plugin module implements client options behavior.
import type { RetryOptions, WebClientOptions } from "@slack/web-api";
import {
  createHttp1EnvHttpProxyAgent,
  resolveEnvHttpProxyAgentOptions,
} from "openclaw/plugin-sdk/fetch-runtime";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";

type SlackProxyDispatcher = ReturnType<typeof createHttp1EnvHttpProxyAgent>;
export type SlackLookupClientOptions = Pick<WebClientOptions, "fetch" | "slackApiUrl" | "timeout">;

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

const SLACK_LOOKUP_TIMEOUT_MS = 30_000;

const SLACK_LOOKUP_RETRY_OPTIONS: RetryOptions = {
  retries: 0,
};

/** Build the dispatcher shared by Slack Web API fetches and Socket Mode. */
export function resolveSlackProxyDispatcher(): SlackProxyDispatcher | undefined {
  const options = resolveEnvHttpProxyAgentOptions();
  if (!options) {
    return undefined;
  }
  try {
    return createHttp1EnvHttpProxyAgent(options);
  } catch {
    // Malformed proxy URL; degrade gracefully to direct connections.
    return undefined;
  }
}

function createSlackDispatcherFetch(
  dispatcher: SlackProxyDispatcher,
): NonNullable<WebClientOptions["fetch"]> {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithRuntimeDispatcher(input, { ...init, dispatcher })) as NonNullable<
    WebClientOptions["fetch"]
  >;
}

function resolveSlackApiUrlFromEnv(): string | undefined {
  return process.env.SLACK_API_URL?.trim() || undefined;
}

function applySlackApiUrlAndProxyOptions(
  options: WebClientOptions,
  dispatcher?: SlackProxyDispatcher,
): void {
  const slackApiUrl = options.slackApiUrl ?? resolveSlackApiUrlFromEnv();
  if (dispatcher && !options.fetch) {
    options.fetch = createSlackDispatcherFetch(dispatcher);
  }
  if (slackApiUrl !== undefined) {
    options.slackApiUrl = slackApiUrl;
  } else {
    delete options.slackApiUrl;
  }
}

export function resolveSlackWebClientOptions(
  options: WebClientOptions = {},
  dispatcher = resolveSlackProxyDispatcher(),
): WebClientOptions {
  const resolved: WebClientOptions = Object.assign({}, options);
  applySlackApiUrlAndProxyOptions(resolved, dispatcher);
  resolved.retryConfig ??= SLACK_DEFAULT_RETRY_OPTIONS;
  return resolved;
}

export function resolveSlackWriteClientOptions(
  options: WebClientOptions = {},
  dispatcher = resolveSlackProxyDispatcher(),
): WebClientOptions {
  const resolved: WebClientOptions = Object.assign({}, options);
  applySlackApiUrlAndProxyOptions(resolved, dispatcher);
  resolved.retryConfig ??= SLACK_WRITE_RETRY_OPTIONS;
  return resolved;
}

export function resolveSlackLookupClientOptions(
  options: SlackLookupClientOptions = {},
  dispatcher = resolveSlackProxyDispatcher(),
): WebClientOptions {
  const resolved: WebClientOptions = Object.assign({}, options);
  applySlackApiUrlAndProxyOptions(resolved, dispatcher);
  // Slack otherwise sleeps through the full Retry-After window after receiving 429,
  // outside the Axios request timeout.
  resolved.rejectRateLimitedCalls = true;
  resolved.retryConfig = SLACK_LOOKUP_RETRY_OPTIONS;
  resolved.timeout ??= SLACK_LOOKUP_TIMEOUT_MS;
  return resolved;
}
