import { WebClient as SlackWebClient, type WebClientOptions } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackMonitorDispatchers } from "./client-options.js";
import {
  createSlackTokenCacheKey,
  getSlackWriteClient,
  resolveSlackWebClientOptions,
  SLACK_WRITE_RETRY_OPTIONS,
} from "./client.js";

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

const mockWebClient = vi.mocked(SlackWebClient);

const TEST_ENV_KEYS = [
  "SLACK_API_URL",
  "OPENCLAW_SLACK_API_URL",
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

function requireFetch(options: WebClientOptions): NonNullable<WebClientOptions["fetch"]> {
  if (!options.fetch) {
    throw new Error("expected dispatcher-backed fetch");
  }
  return options.fetch;
}

beforeEach(() => {
  mockWebClient.mockClear();
  for (const key of TEST_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  isDebugProxyGlobalFetchPatchInstalledMock.mockReturnValue(false);
});

afterEach(() => vi.unstubAllEnvs());

describe("slack web client config", () => {
  it.each([
    ["token", "xoxb-one", {}, "xoxb-two", {}],
    [
      "API URL",
      "xoxb-test",
      { slackApiUrl: "http://a.test/api/" },
      "xoxb-test",
      { slackApiUrl: "http://b.test/api/" },
    ],
  ] as const)(
    "keeps write clients separated by %s",
    (_, firstToken, firstOptions, secondToken, secondOptions) => {
      const first = getSlackWriteClient(firstToken, firstOptions);
      const second = getSlackWriteClient(secondToken, secondOptions);
      expect(second).not.toBe(first);
      expect(mockWebClient).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps one org token partitioned by workspace", () => {
    const first = getSlackWriteClient("xoxb-org", { teamId: "T1" });
    const reused = getSlackWriteClient("xoxb-org", { teamId: "T1" });
    const second = getSlackWriteClient("xoxb-org", { teamId: "T2" });

    expect(reused).toBe(first);
    expect(second).not.toBe(first);
    expect(mockWebClient).toHaveBeenCalledTimes(2);
    const writeOptions = {
      fetch: expect.any(Function),
      rejectRateLimitedCalls: true,
      retryConfig: SLACK_WRITE_RETRY_OPTIONS,
    };
    expect(mockWebClient.mock.calls).toEqual([
      ["xoxb-org", { ...writeOptions, teamId: "T1" }],
      ["xoxb-org", { ...writeOptions, teamId: "T2" }],
    ]);
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
