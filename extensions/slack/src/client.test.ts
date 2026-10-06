// Slack tests cover client plugin behavior.
import type { WebClientOptions } from "@slack/web-api";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { isDebugProxyGlobalFetchPatchInstalledMock } = vi.hoisted(() => ({
  isDebugProxyGlobalFetchPatchInstalledMock: vi.fn(() => false),
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  isDebugProxyGlobalFetchPatchInstalled: isDebugProxyGlobalFetchPatchInstalledMock,
}));

vi.mock("@slack/web-api", async (importOriginal) => {
  const { WebAPIRateLimitedError } = await importOriginal<typeof import("@slack/web-api")>();
  const WebClient = vi.fn(function WebClientMock(
    this: Record<string, unknown>,
    token: string,
    options?: Record<string, unknown>,
  ) {
    this.token = token;
    this.options = options;
  });
  return { WebClient, WebAPIRateLimitedError };
});

let createSlackWebClient: typeof import("./client.js").createSlackWebClient;
let createSlackLookupClient: typeof import("./client.js").createSlackLookupClient;
let createSlackReadClient: typeof import("./client.js").createSlackReadClient;
let createSlackStartupAuthClient: typeof import("./client.js").createSlackStartupAuthClient;
let createSlackWriteClient: typeof import("./client.js").createSlackWriteClient;
let createSlackTokenCacheKey: typeof import("./client.js").createSlackTokenCacheKey;
let getSlackWriteClient: typeof import("./client.js").getSlackWriteClient;
let resolveSlackMonitorDispatchers: typeof import("./client-options.js").resolveSlackMonitorDispatchers;
let resolveSlackWebClientOptions: typeof import("./client.js").resolveSlackWebClientOptions;
let resolveSlackWriteClientOptions: typeof import("./client.js").resolveSlackWriteClientOptions;
let SLACK_DEFAULT_RETRY_OPTIONS: typeof import("./client.js").SLACK_DEFAULT_RETRY_OPTIONS;
let SLACK_WRITE_RETRY_OPTIONS: typeof import("./client.js").SLACK_WRITE_RETRY_OPTIONS;
let WebClient: ReturnType<typeof vi.fn>;

const SLACK_API_URL_KEYS = ["SLACK_API_URL", "OPENCLAW_SLACK_API_URL"] as const;
const PROXY_KEYS = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;
const originalEnv = { ...process.env };

function clearProxyEnvForTest() {
  for (const key of PROXY_KEYS) {
    delete process.env[key];
  }
}

function restoreProxyEnvForTest() {
  for (const key of PROXY_KEYS) {
    if (originalEnv[key] !== undefined) {
      process.env[key] = originalEnv[key];
    } else {
      delete process.env[key];
    }
  }
}

function clearSlackApiUrlEnvForTest() {
  for (const key of SLACK_API_URL_KEYS) {
    delete process.env[key];
  }
}

function restoreSlackApiUrlEnvForTest() {
  for (const key of SLACK_API_URL_KEYS) {
    if (originalEnv[key] !== undefined) {
      process.env[key] = originalEnv[key];
    } else {
      delete process.env[key];
    }
  }
}

function requireFetch(options: WebClientOptions): NonNullable<WebClientOptions["fetch"]> {
  if (!options.fetch) {
    throw new Error("expected dispatcher-backed fetch");
  }
  return options.fetch;
}

beforeAll(async () => {
  const slackWebApi = await import("@slack/web-api");
  ({ resolveSlackMonitorDispatchers } = await import("./client-options.js"));
  ({
    createSlackWebClient,
    createSlackLookupClient,
    createSlackReadClient,
    createSlackStartupAuthClient,
    createSlackWriteClient,
    createSlackTokenCacheKey,
    getSlackWriteClient,
    resolveSlackWebClientOptions,
    resolveSlackWriteClientOptions,
    SLACK_DEFAULT_RETRY_OPTIONS,
    SLACK_WRITE_RETRY_OPTIONS,
  } = await import("./client.js"));
  WebClient = slackWebApi.WebClient as unknown as ReturnType<typeof vi.fn>;
});

beforeEach(() => {
  WebClient.mockClear();
  clearSlackApiUrlEnvForTest();
  clearProxyEnvForTest();
  isDebugProxyGlobalFetchPatchInstalledMock.mockReturnValue(false);
});

afterEach(() => {
  restoreSlackApiUrlEnvForTest();
  restoreProxyEnvForTest();
});

describe("slack web client config", () => {
  it("applies the default retry config when none is provided", () => {
    const options = resolveSlackWebClientOptions();

    expect(options.retryConfig).toEqual(SLACK_DEFAULT_RETRY_OPTIONS);
    expect(options.timeout).toBeUndefined();
  });

  it("applies a 30-second deadline only to dedicated read clients", () => {
    createSlackReadClient("xoxb-read");

    expect(WebClient).toHaveBeenCalledWith(
      "xoxb-read",
      expect.objectContaining({
        fetch: expect.any(Function),
        retryConfig: SLACK_DEFAULT_RETRY_OPTIONS,
        timeout: 30_000,
      }),
    );
  });

  it("respects explicit retry config overrides", () => {
    const customRetry = { retries: 0 };
    const options = resolveSlackWebClientOptions({ retryConfig: customRetry });

    expect(options.retryConfig).toBe(customRetry);
  });

  it("does not read OPENCLAW_SLACK_API_URL as a default Slack Web API root", () => {
    process.env.OPENCLAW_SLACK_API_URL = "http://127.0.0.1:49152/api/";

    expect(resolveSlackWebClientOptions().slackApiUrl).toBeUndefined();
    expect(resolveSlackWriteClientOptions().slackApiUrl).toBeUndefined();
  });

  it("passes merged options into WebClient", async () => {
    const customFetch = vi.fn() as never;

    createSlackWebClient("xoxb-test", { timeout: 1234, fetch: customFetch });

    expect(WebClient).toHaveBeenCalledWith("xoxb-test", {
      fetch: expect.any(Function),
      retryConfig: SLACK_DEFAULT_RETRY_OPTIONS,
      timeout: 1234,
    });
    await WebClient.mock.calls[0]?.[1]?.fetch?.("https://slack.test/api/");
    expect(customFetch).toHaveBeenCalledWith("https://slack.test/api/", undefined);
  });

  it("bounds startup auth while preserving listener transport options", () => {
    const customFetch = vi.fn() as never;

    createSlackStartupAuthClient("xoxb-startup", {
      fetch: customFetch,
      slackApiUrl: "https://slack.test/api/",
    });

    expect(WebClient).toHaveBeenCalledWith(
      "xoxb-startup",
      expect.objectContaining({
        fetch: expect.any(Function),
        retryConfig: { ...SLACK_DEFAULT_RETRY_OPTIONS, maxRetryTime: 35_000 },
        slackApiUrl: "https://slack.test/api/",
        timeout: 10_000,
      }),
    );
    const options = WebClient.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.fetch).not.toBe(customFetch);
    expect(options).not.toHaveProperty("rejectRateLimitedCalls");
  });

  it("passes the bounded lookup policy into WebClient", async () => {
    const customFetch = vi.fn() as never;

    createSlackLookupClient("lookup-fixture", { fetch: customFetch });

    expect(WebClient).toHaveBeenCalledWith("lookup-fixture", {
      fetch: expect.any(Function),
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
      timeout: 30_000,
    });
    await WebClient.mock.calls[0]?.[1]?.fetch?.("https://slack.test/api/");
    expect(customFetch).toHaveBeenCalledWith("https://slack.test/api/", undefined);
  });

  it("passes no-retry config into the write client by default", () => {
    const customFetch = vi.fn() as never;

    createSlackWriteClient("xoxb-test", { timeout: 4321, fetch: customFetch });

    expect(WebClient).toHaveBeenCalledWith("xoxb-test", {
      fetch: expect.any(Function),
      rejectRateLimitedCalls: true,
      retryConfig: SLACK_WRITE_RETRY_OPTIONS,
      timeout: 4321,
    });
  });

  it("reuses default write clients per token", () => {
    const first = getSlackWriteClient("xoxb-test");
    const second = getSlackWriteClient("xoxb-test");

    expect(second).toBe(first);
    expect(WebClient).toHaveBeenCalledTimes(1);
    expect(WebClient).toHaveBeenCalledWith("xoxb-test", {
      fetch: expect.any(Function),
      rejectRateLimitedCalls: true,
      retryConfig: SLACK_WRITE_RETRY_OPTIONS,
    });
  });

  it("keeps default write clients separated by token", () => {
    const first = getSlackWriteClient("xoxb-one");
    const second = getSlackWriteClient("xoxb-two");

    expect(second).not.toBe(first);
    expect(WebClient).toHaveBeenCalledTimes(2);
  });

  it("keeps one org token partitioned by workspace", () => {
    const first = getSlackWriteClient("xoxb-org", { teamId: "T1" });
    const reused = getSlackWriteClient("xoxb-org", { teamId: "T1" });
    const second = getSlackWriteClient("xoxb-org", { teamId: "T2" });

    expect(reused).toBe(first);
    expect(second).not.toBe(first);
    expect(WebClient).toHaveBeenCalledTimes(2);
    expect(WebClient).toHaveBeenNthCalledWith(1, "xoxb-org", {
      fetch: expect.any(Function),
      rejectRateLimitedCalls: true,
      retryConfig: SLACK_WRITE_RETRY_OPTIONS,
      teamId: "T1",
    });
    expect(WebClient).toHaveBeenNthCalledWith(2, "xoxb-org", {
      fetch: expect.any(Function),
      rejectRateLimitedCalls: true,
      retryConfig: SLACK_WRITE_RETRY_OPTIONS,
      teamId: "T2",
    });
  });

  it("keeps write clients separated by Slack API URL client options", () => {
    const firstOptions = {
      slackApiUrl: "http://127.0.0.1:49152/api/",
    };
    const secondOptions = {
      slackApiUrl: "http://127.0.0.1:49153/api/",
    };
    const first = getSlackWriteClient("xoxb-test", firstOptions);
    const second = getSlackWriteClient("xoxb-test", secondOptions);

    expect(second).not.toBe(first);
    expect(WebClient).toHaveBeenCalledTimes(2);
  });

  it("keeps write clients separated by SLACK_API_URL", () => {
    process.env.SLACK_API_URL = "http://127.0.0.1:49152/api/";
    const first = getSlackWriteClient("xoxb-env");
    process.env.SLACK_API_URL = "http://127.0.0.1:49153/api/";
    const second = getSlackWriteClient("xoxb-env");

    expect(second).not.toBe(first);
    expect(WebClient).toHaveBeenCalledTimes(2);
  });

  it("builds stable non-secret token cache keys", () => {
    const token = "xoxb-sensitive-token";
    const first = createSlackTokenCacheKey(token);
    const second = createSlackTokenCacheKey(token);

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:/);
    expect(first).not.toContain(token);
    expect(createSlackTokenCacheKey("xoxb-other-token")).not.toBe(first);
  });
});

describe("slack proxy dispatcher", () => {
  it("attaches one dispatcher-backed fetch for HTTPS_PROXY", async () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    const dispatchers = resolveSlackMonitorDispatchers("http");
    const options = resolveSlackWebClientOptions({}, dispatchers.webApi);

    expect(dispatchers.webApi?.constructor.name).toBe("EnvHttpProxyAgent");
    expect(requireFetch(options)).toBeTypeOf("function");
    await dispatchers.close();
  });

  it("keeps the capture-patched global fetch with ambient proxy env", async () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    isDebugProxyGlobalFetchPatchInstalledMock.mockReturnValue(true);
    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const dispatchers = resolveSlackMonitorDispatchers("http");
    try {
      const options = resolveSlackWebClientOptions({}, dispatchers.webApi);
      await requireFetch(options)("https://slack.com/api/auth.test");
      expect(globalFetch).toHaveBeenCalledOnce();
    } finally {
      globalFetch.mockRestore();
      await dispatchers.close();
    }
  });

  it("attaches the shared fetch when no proxy env var is configured", async () => {
    const dispatchers = resolveSlackMonitorDispatchers("http");
    expect(dispatchers.webApi).toBeUndefined();
    expect(requireFetch(resolveSlackWebClientOptions())).toBeTypeOf("function");
    await dispatchers.close();
  });

  it("preserves an explicitly provided fetch", async () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:3128";
    const customFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const dispatchers = resolveSlackMonitorDispatchers("http");
    const options = resolveSlackWebClientOptions({ fetch: customFetch }, dispatchers.webApi);

    await requireFetch(options)("https://slack.invalid/api/auth.test");
    expect(customFetch).toHaveBeenCalledWith("https://slack.invalid/api/auth.test", undefined);
    await dispatchers.close();
  });

  it("treats empty lowercase https_proxy as authoritative over uppercase", async () => {
    process.env.https_proxy = "";
    process.env.HTTPS_PROXY = "http://upper.example.com:3128";

    const dispatchers = resolveSlackMonitorDispatchers("http");
    expect(dispatchers.webApi).toBeUndefined();
    await dispatchers.close();
  });

  it("degrades gracefully on malformed proxy URL", async () => {
    process.env.HTTPS_PROXY = "not-a-valid-url://:::bad";

    const dispatchers = resolveSlackMonitorDispatchers("http");
    expect(dispatchers.webApi).toBeUndefined();
    expect(requireFetch(resolveSlackWebClientOptions())).toBeTypeOf("function");
    await dispatchers.close();
  });
});
