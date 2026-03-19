import { type RetryOptions, type WebClientOptions, WebClient } from "@slack/web-api";
import { HttpsProxyAgent } from "https-proxy-agent";
import { resolveEnvHttpProxyUrl } from "openclaw/plugin-sdk/infra-runtime";

export const SLACK_DEFAULT_RETRY_OPTIONS: RetryOptions = {
  retries: 2,
  factor: 2,
  minTimeout: 500,
  maxTimeout: 3000,
  randomize: true,
};

function resolveSlackEnvProxyAgent(
  env: NodeJS.ProcessEnv = process.env,
): WebClientOptions["agent"] | undefined {
  const proxyUrl = resolveEnvHttpProxyUrl("https", env);
  if (!proxyUrl) {
    return undefined;
  }
  return new HttpsProxyAgent(proxyUrl);
}

export function resolveSlackWebClientOptions(
  options: WebClientOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): WebClientOptions {
  const envProxyAgent = options.agent ? undefined : resolveSlackEnvProxyAgent(env);
  return {
    ...options,
    ...(envProxyAgent ? { agent: envProxyAgent } : {}),
    retryConfig: options.retryConfig ?? SLACK_DEFAULT_RETRY_OPTIONS,
  };
}

export function createSlackWebClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, resolveSlackWebClientOptions(options));
}
