import { createRequire } from "node:module";
import { WebAPIRateLimitedError, type RetryOptions, type WebClientOptions } from "@slack/web-api";
import {
  addActiveManagedProxyTlsOptions,
  createHttp1EnvHttpProxyAgent,
  captureChannelReadAuthority,
  resolveFetch,
  resolveEnvHttpProxyAgentOptions,
} from "openclaw/plugin-sdk/fetch-runtime";
import { isDebugProxyGlobalFetchPatchInstalled } from "openclaw/plugin-sdk/proxy-capture";
import { parseRetryAfterHeaderSeconds, retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
import type { EnvHttpProxyAgent as SlackSocketModeEnvHttpProxyAgent } from "undici";

export type SlackProxyDispatcher = ReturnType<typeof createHttp1EnvHttpProxyAgent>;
export type SlackSocketModeDispatcher = SlackSocketModeEnvHttpProxyAgent;
export type SlackLookupClientOptions = Pick<
  WebClientOptions,
  "fetch" | "slackApiUrl" | "teamId" | "timeout"
>;

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

const SLACK_READ_TIMEOUT_MS = 30_000;

const SLACK_LOOKUP_RETRY_OPTIONS: RetryOptions = {
  retries: 0,
};

function normalizeSlackFetchInit(init?: RequestInit): RequestInit | undefined {
  if (init?.body !== "") {
    return init;
  }
  // Parameterless Slack Web API calls use an explicit empty body. Older Undici HTTP/2
  // clients can leave that request stream open instead of setting END_STREAM on HEADERS.
  const { body: _body, ...rest } = init;
  return rest;
}

/** Build the dispatcher for Slack Web API fetches (paired with the runtime fetch). */
function resolveSlackProxyDispatcher(): SlackProxyDispatcher | undefined {
  const options = resolveEnvHttpProxyAgentOptions();
  if (!options) {
    return undefined;
  }
  try {
    return createHttp1EnvHttpProxyAgent(options, undefined, process.env);
  } catch {
    // Malformed proxy URL; degrade gracefully to direct connections.
    return undefined;
  }
}

type SlackSocketModeUndici = Pick<typeof import("undici"), "EnvHttpProxyAgent">;
let slackSocketModeUndici: SlackSocketModeUndici | undefined;

/**
 * Load the undici copy that @slack/socket-mode opens its WebSocket with.
 *
 * Socket Mode 3 calls `new undici.WebSocket(url, { dispatcher })` with its own
 * undici. A dispatcher from another undici copy fails the handshake, so we must
 * identify whether Socket Mode can share the runtime dispatcher. The explicit
 * `undici/index.js` subpath keeps Bun's bare-`undici` placeholder out of the
 * dispatcher (the same reason the runtime loads undici this way); under Bun,
 * Socket Mode's bare import gets Bun's WebSocket, which does not consult a
 * dispatcher at all.
 */
function loadSlackSocketModeUndici(): SlackSocketModeUndici {
  if (slackSocketModeUndici) {
    return slackSocketModeUndici;
  }
  const requireFromPlugin = createRequire(import.meta.url);
  const requireFromBolt = createRequire(requireFromPlugin.resolve("@slack/bolt/package.json"));
  const requireFromSocketMode = createRequire(
    requireFromBolt.resolve("@slack/socket-mode/package.json"),
  );
  // SAFETY: package-relative resolution pins this require to Socket Mode's declared undici.
  slackSocketModeUndici = requireFromSocketMode("undici/index.js") as SlackSocketModeUndici;
  return slackSocketModeUndici;
}

/**
 * Build the env-proxy dispatcher for Socket Mode's WebSocket.
 *
 * Reuse the Web API dispatcher when both transports load the same undici copy;
 * its custom proxy routing supports Socket Mode's CONNECT handshake. Otherwise
 * build one from Socket Mode's copy. Without a proxy env, preserve the default
 * direct connection.
 */
function resolveSlackSocketModeDispatcher(
  webApi: SlackProxyDispatcher | undefined,
): SlackSocketModeDispatcher | undefined {
  const options = resolveEnvHttpProxyAgentOptions();
  if (!options) {
    return undefined;
  }
  // Loading the matching runtime is part of the Socket Mode compatibility
  // contract. Do not silently bypass a configured proxy if packaging breaks it.
  const { EnvHttpProxyAgent } = loadSlackSocketModeUndici();
  if (webApi instanceof EnvHttpProxyAgent) {
    return webApi;
  }
  const agentOptions = addActiveManagedProxyTlsOptions(options);
  try {
    return new EnvHttpProxyAgent(agentOptions);
  } catch {
    // Preserve the existing direct-connection fallback for malformed proxy URLs.
    return undefined;
  }
}

/** Pair each Slack monitor transport with the dispatcher from the undici copy it uses. */
export function resolveSlackMonitorDispatchers(mode: "socket" | "http" | "relay") {
  const webApi = resolveSlackProxyDispatcher();
  const socketMode = mode === "socket" ? resolveSlackSocketModeDispatcher(webApi) : undefined;
  return {
    webApi,
    socketMode,
    close: async () => {
      await webApi?.close();
      if (socketMode !== webApi) {
        await socketMode?.close();
      }
    },
  };
}

const DIRECT_SLACK_DISPATCHER_OPTIONS = {
  httpProxy: "",
  httpsProxy: "",
  noProxy: "*",
};

/** Create a probe-owned dispatcher so timeout cleanup can retire every socket. */
export function createSlackProbeDispatcher(timeoutMs: number): SlackProxyDispatcher {
  const options = resolveEnvHttpProxyAgentOptions() ?? DIRECT_SLACK_DISPATCHER_OPTIONS;
  try {
    return createHttp1EnvHttpProxyAgent(options, timeoutMs, process.env);
  } catch {
    // Invalid ambient proxy settings must not prevent a direct health check.
    return createHttp1EnvHttpProxyAgent(DIRECT_SLACK_DISPATCHER_OPTIONS, timeoutMs, {});
  }
}

function buildSlackFetch(
  dispatcher?: SlackProxyDispatcher,
): NonNullable<WebClientOptions["fetch"]> | undefined {
  if (!dispatcher || isDebugProxyGlobalFetchPatchInstalled()) {
    // Debug capture patches global fetch after installing its proxy-aware dispatcher.
    // A package-owned fetch would bypass capture whenever ambient proxy env is present.
    const slackFetch = resolveFetch();
    if (!slackFetch) {
      return undefined;
    }
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      slackFetch(input, normalizeSlackFetchInit(init))) as NonNullable<WebClientOptions["fetch"]>;
  }
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    return fetchWithRuntimeDispatcher(input, {
      ...normalizeSlackFetchInit(init),
      dispatcher,
    });
  }) as NonNullable<WebClientOptions["fetch"]>;
}

function fenceSlackReadFetch(
  slackFetch: NonNullable<WebClientOptions["fetch"]>,
): NonNullable<WebClientOptions["fetch"]> {
  // Read/lookup clients are operation-local. Capture before the SDK queues or
  // retries, and also honor a caller scope when an unscoped client is reused.
  const assertReadAuthority = captureChannelReadAuthority();
  return (input, init) => {
    assertReadAuthority?.();
    captureChannelReadAuthority()?.();
    return slackFetch(input, init);
  };
}

function resolveSlackApiUrlFromEnv(): string | undefined {
  return process.env.SLACK_API_URL?.trim() || undefined;
}

function applySlackApiUrlAndProxyOptions(
  options: WebClientOptions,
  dispatcher?: SlackProxyDispatcher,
): void {
  const slackApiUrl = options.slackApiUrl ?? resolveSlackApiUrlFromEnv();
  const fetch = options.fetch ?? buildSlackFetch(dispatcher);
  if (fetch) {
    options.fetch = fenceSlackReadFetch(fetch);
  }
  if (slackApiUrl !== undefined) {
    options.slackApiUrl = slackApiUrl;
  } else {
    delete options.slackApiUrl;
  }
}

function applySlackRequestAuthority(
  options: WebClientOptions,
  dispatcher: SlackProxyDispatcher | undefined,
  assertDirectAdapterHandoff: (() => void) | undefined,
): void {
  if (!assertDirectAdapterHandoff) {
    return;
  }
  const slackFetch = options.fetch ?? buildSlackFetch(dispatcher);
  if (!slackFetch) {
    throw new Error("Slack request fetch is unavailable for live authority.");
  }
  options.fetch = (input, init) => {
    assertDirectAdapterHandoff();
    return slackFetch(input, init);
  };
}

export function resolveSlackWebClientOptions(
  options: WebClientOptions = {},
  dispatcher = resolveSlackProxyDispatcher(),
  assertDirectAdapterHandoff?: () => void,
): WebClientOptions {
  const resolved: WebClientOptions = Object.assign({}, options);
  applySlackApiUrlAndProxyOptions(resolved, dispatcher);
  resolved.fetch ??= buildSlackFetch(dispatcher);
  applySlackRequestAuthority(resolved, dispatcher, assertDirectAdapterHandoff);
  resolved.retryConfig ??= SLACK_DEFAULT_RETRY_OPTIONS;
  return resolved;
}

export function resolveSlackReadClientOptions(
  options: WebClientOptions = {},
  dispatcher = resolveSlackProxyDispatcher(),
  assertDirectAdapterHandoff?: () => void,
): WebClientOptions {
  // The Slack SDK applies timeout per retry attempt. Keep its established read retry
  // policy, while ensuring any one stalled request eventually releases the caller.
  const resolved = resolveSlackWebClientOptions(options, dispatcher, assertDirectAdapterHandoff);
  resolved.timeout ??= SLACK_READ_TIMEOUT_MS;
  return resolved;
}

export function resolveSlackWriteClientOptions(
  options: WebClientOptions = {},
  dispatcher = resolveSlackProxyDispatcher(),
  assertDirectAdapterHandoff?: () => void,
): WebClientOptions {
  const resolved: WebClientOptions = Object.assign({}, options);
  applySlackApiUrlAndProxyOptions(resolved, dispatcher);
  applySlackRequestAuthority(resolved, dispatcher, assertDirectAdapterHandoff);
  resolved.retryConfig ??= SLACK_WRITE_RETRY_OPTIONS;
  // A caller's nonzero SDK retry policy already owns rate-limit recovery.
  if (resolved.rejectRateLimitedCalls !== true && resolved.retryConfig.retries === 0) {
    const slackFetch = resolved.fetch ?? buildSlackFetch(dispatcher);
    if (slackFetch) {
      // Replay the SDK's serialized body, not chatStream.append(), which retains
      // its buffer after rejection. Only an HTTP 429 proves this write was refused.
      resolved.fetch = (input, init) =>
        retryAsync(
          async () => {
            init?.signal?.throwIfAborted();
            const response = await slackFetch(input, init);
            if (response.status !== 429) {
              return response;
            }
            const retryAfter = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
            // Do not wait for peer EOF or a capture tee before retry/abort can proceed.
            // SAFETY: Runtime fetch responses expose an optional standard body stream.
            void (response as { body?: ReadableStream | null }).body
              ?.cancel()
              .catch(() => undefined);
            init?.signal?.throwIfAborted();
            // The shared abortable timer caps one sleep at this platform limit;
            // refuse an unrepresentable delay instead of retrying before Slack allows.
            if (retryAfter === undefined || retryAfter * 1000 > 2_147_000_000) {
              return response;
            }
            throw new WebAPIRateLimitedError(retryAfter);
          },
          {
            attempts: 3,
            minDelayMs: 0,
            maxDelayMs: 0,
            shouldRetry: (error) => error instanceof WebAPIRateLimitedError,
            retryAfterMs: (error) =>
              error instanceof WebAPIRateLimitedError ? error.retryAfter * 1000 : undefined,
            sleep: (delayMs) => sleepWithAbort(delayMs, init?.signal),
          },
        );
    }
    // Preserve the explicit opt-out and avoid SDK sleeps/retries after our budget.
    resolved.rejectRateLimitedCalls = true;
  }
  return resolved;
}

export function resolveSlackLookupClientOptions(
  options: SlackLookupClientOptions = {},
  dispatcher = resolveSlackProxyDispatcher(),
  assertDirectAdapterHandoff?: () => void,
): WebClientOptions {
  const resolved: WebClientOptions = Object.assign({}, options);
  applySlackApiUrlAndProxyOptions(resolved, dispatcher);
  applySlackRequestAuthority(resolved, dispatcher, assertDirectAdapterHandoff);
  // Slack otherwise sleeps through the full Retry-After window after receiving 429,
  // outside the Axios request timeout.
  resolved.rejectRateLimitedCalls = true;
  resolved.retryConfig = SLACK_LOOKUP_RETRY_OPTIONS;
  resolved.timeout ??= SLACK_READ_TIMEOUT_MS;
  return resolved;
}
