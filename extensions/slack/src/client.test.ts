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

let createSlackTokenCacheKey: typeof import("./client.js").createSlackTokenCacheKey;
let getSlackWriteClient: typeof import("./client.js").getSlackWriteClient;
let resolveSlackMonitorDispatchers: typeof import("./client-options.js").resolveSlackMonitorDispatchers;
let resolveSlackWebClientOptions: typeof import("./client.js").resolveSlackWebClientOptions;
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
    createSlackTokenCacheKey,
    getSlackWriteClient,
    resolveSlackWebClientOptions,
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

  it("degrades gracefully on malformed proxy URL", async () => {
    process.env.HTTPS_PROXY = "not-a-valid-url://:::bad";

    const dispatchers = resolveSlackMonitorDispatchers("http");
    expect(dispatchers.webApi).toBeUndefined();
    expect(requireFetch(resolveSlackWebClientOptions())).toBeTypeOf("function");
    await dispatchers.close();
  });
});
