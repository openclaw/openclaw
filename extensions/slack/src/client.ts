import { type RetryOptions, type WebClientOptions, WebClient } from "@slack/web-api";
import { HttpsProxyAgent } from "https-proxy-agent";
import { resolveEnvHttpProxyUrl } from "openclaw/plugin-sdk/infra-runtime";

let httpsProxyAgentCtor: typeof HttpsProxyAgent = HttpsProxyAgent;

export const SLACK_DEFAULT_RETRY_OPTIONS: RetryOptions = {
  retries: 2,
  factor: 2,
  minTimeout: 500,
  maxTimeout: 3000,
  randomize: true,
};

function resolveProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl = resolveEnvHttpProxyUrl("https");
  if (!proxyUrl) return undefined;
  try {
    return new httpsProxyAgentCtor(proxyUrl);
  } catch {
    return undefined;
  }
}

export function resolveSlackWebClientOptions(options: WebClientOptions = {}): WebClientOptions {
  const agent = options.agent ?? resolveProxyAgent();
  return {
    ...options,
    retryConfig: options.retryConfig ?? SLACK_DEFAULT_RETRY_OPTIONS,
    ...(agent ? { agent } : {}),
  };
}

export function setSlackClientRuntimeForTest(overrides?: {
  HttpsProxyAgent?: typeof HttpsProxyAgent;
}): void {
  httpsProxyAgentCtor = overrides?.HttpsProxyAgent ?? HttpsProxyAgent;
}

export function createSlackWebClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, resolveSlackWebClientOptions(options));
}
