import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const catalogTransport = vi.hoisted(() => {
  const releases: Array<() => Promise<void>> = [];
  return {
    lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    releases,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      const result = await actual.fetchWithSsrFGuard({
        ...params,
        lookupFn: catalogTransport.lookup,
      });
      const release = vi.fn(result.release);
      catalogTransport.releases.push(release);
      return { ...result, release };
    },
  };
});

const getTokenProviderMock = vi.hoisted(() => vi.fn());
vi.mock("@aws/bedrock-token-generator", () => ({ getTokenProvider: getTokenProviderMock }));

const discoveryDebugSpy = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/core")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "bedrock-mantle-discovery"
        ? {
            ...logger,
            debug: discoveryDebugSpy,
            isEnabled: (...args: Parameters<typeof logger.isEnabled>) =>
              args[0] === "debug" ? true : logger.isEnabled(...args),
          }
        : logger;
    },
  };
});

const {
  discoverMantleModels,
  generateBearerTokenFromIam,
  MANTLE_IAM_TOKEN_MARKER,
  resolveImplicitMantleProvider: resolveProvider,
  resolveMantleRuntimeBearerToken,
} = await import("./api.js");

function modelResponse(...ids: string[]) {
  return Response.json({ data: ids.map((id) => ({ id })) });
}

describe("bedrock mantle discovery", () => {
  let testRegionIndex = 0;
  let testRegion = "";
  let now = 0;
  const fetchMock = vi.fn<typeof fetch>();
  const tokenProvider = vi.fn(async () => "synthetic-runtime-token");
  const discover = (overrides: Partial<Parameters<typeof discoverMantleModels>[0]> = {}) =>
    discoverMantleModels({ region: testRegion, bearerToken: "test-token", ...overrides });

  beforeEach(() => {
    catalogTransport.lookup
      .mockReset()
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    catalogTransport.releases.length = 0;
    getTokenProviderMock.mockReset().mockReturnValue(tokenProvider);
    tokenProvider.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    now = Date.UTC(2026, 7, 31);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    discoveryDebugSpy.mockClear();
    testRegion = `test-region-${++testRegionIndex}`;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const release of catalogTransport.releases) {
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it.each([
    {
      label: "disabled discovery",
      env: { AWS_REGION: "us-east-1" },
      pluginConfig: { discovery: { enabled: false } },
    },
    {
      label: "unsupported region",
      env: { AWS_REGION: "af-south-1", AWS_BEARER_TOKEN_BEDROCK: "my-token" },
    },
  ])("skips IAM generation for $label", async ({ env, pluginConfig }) => {
    getTokenProviderMock.mockImplementation(() => {
      throw new Error("rejected discovery should not generate a token");
    });
    await expect(resolveProvider({ env, pluginConfig })).resolves.toBeNull();
    expect(getTokenProviderMock).not.toHaveBeenCalled();
  });

  it("infers reasoning support from model IDs", async () => {
    const expected = {
      "moonshotai.kimi-k2-thinking": true,
      "openai.gpt-oss-120b": true,
      "openai.gpt-oss-safeguard-120b": true,
      "deepseek.v3.2": false,
      "mistral.mistral-large-3-675b-instruct": false,
    };
    fetchMock.mockResolvedValue(modelResponse(...Object.keys(expected)));
    const models = await discover();
    expect(Object.fromEntries(models.map((m) => [m.id, m.reasoning]))).toEqual(expected);
  });

  it("aborts Mantle discovery when its request deadline expires", async () => {
    vi.useFakeTimers();
    const started = createDeferred<AbortSignal>();
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          assert(signal, "Missing discovery abort signal");
          started.resolve(signal);
          signal.addEventListener(
            "abort",
            () => {
              assert(signal.reason instanceof Error);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const discovery = discover({ discoveryMode: "strict" });
    const rejected = expect(discovery).rejects.toThrow("request timed out");
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(signal.aborted).toBe(true);
  });

  it("rejects a private DNS destination before sending the bearer credential", async () => {
    catalogTransport.lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(discover({ discoveryMode: "strict" })).rejects.toThrow(/private|internal/i);
    expect(catalogTransport.lookup).toHaveBeenCalledWith(`bedrock-mantle.${testRegion}.api.aws`, {
      all: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds successful Mantle model discovery JSON responses", async () => {
    fetchMock.mockResolvedValue(new Response("x".repeat(4 * 1024 * 1024 + 1)));
    await expect(discover({ discoveryMode: "strict" })).rejects.toThrow(
      "JSON response exceeds 4194304 bytes",
    );
  });

  it.each([503, "malformed"])(
    "rejects expired refresh failure %s and recovers",
    async (failure) => {
      fetchMock
        .mockResolvedValueOnce(modelResponse("anthropic.claude-sonnet-4-6"))
        .mockImplementationOnce(async () =>
          Response.json({}, { status: failure === 503 ? 503 : 200 }),
        )
        .mockResolvedValueOnce(modelResponse("openai.gpt-oss-120b"));

      await discover();

      now += 7200_000;
      const refresh = () => discover({ discoveryMode: "strict" });
      await expect(refresh()).rejects.toThrow();
      await expect(refresh()).resolves.toMatchObject([{ id: "openai.gpt-oss-120b" }]);
    },
  );

  it("scopes fresh catalogs to the region and actual bearer credential", async () => {
    fetchMock
      .mockResolvedValueOnce(modelResponse("first-account"))
      .mockResolvedValueOnce(modelResponse("second-account"))
      .mockResolvedValueOnce(modelResponse("second-region"));
    for (const [region, bearerToken, id] of [
      [testRegion, "first-token", "first-account"],
      [testRegion, "second-token", "second-account"],
      [`${testRegion}-other`, "second-token", "second-region"],
    ] as const) {
      await expect(discover({ region, bearerToken })).resolves.toMatchObject([{ id }]);
    }
  });

  it("preserves the strict empty resolver contract without IAM generation", async () => {
    fetchMock.mockResolvedValue(modelResponse());
    getTokenProviderMock.mockImplementation(() => {
      throw new Error("Explicit bearer takes precedence");
    });
    const params = {
      env: {
        AWS_REGION: "eu-south-1",
        AWS_BEARER_TOKEN_BEDROCK: "empty-catalog-strict",
      },
      discoveryMode: "strict" as const,
    };
    await expect(resolveProvider(params)).resolves.toMatchObject({ models: [] });
    await expect(resolveProvider(params)).resolves.toMatchObject({ models: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getTokenProviderMock).not.toHaveBeenCalled();
  });

  it("preserves advisory failure defaults without sharing stale rows across credentials", async () => {
    fetchMock
      .mockResolvedValueOnce(modelResponse("public-model"))
      .mockRejectedValue(new Error("offline"));
    const first = await discover({ bearerToken: "first" });
    now += 7200_000;
    await expect(discover({ bearerToken: "first" })).resolves.toEqual(first);
    await expect(discover({ bearerToken: "first", discoveryMode: "strict" })).rejects.toThrow(
      "offline",
    );
    await expect(discover({ bearerToken: "second" })).resolves.toEqual([]);
    await expect(
      resolveProvider({
        env: { AWS_REGION: "us-east-2", AWS_BEARER_TOKEN_BEDROCK: "public-implicit-failure" },
      }),
    ).resolves.toBeNull();
  });

  it.each([
    { region: "ap-northeast-1", env: { AWS_REGION: "ap-northeast-1" }, modelId: "openai.gpt-5.5" },
    { region: "us-east-1", env: {}, modelId: "openai.gpt-5.6-luna" },
  ])("resolves the explicit bearer provider in $region", async ({ region, env, modelId }) => {
    fetchMock.mockResolvedValue(
      modelResponse("anthropic.claude-sonnet-4-6", modelId, "openai.gpt-oss-120b"),
    );
    const provider = await resolveProvider({
      env: { ...env, AWS_BEARER_TOKEN_BEDROCK: "my-token" },
    });
    expect(provider).toMatchObject({
      baseUrl: `https://bedrock-mantle.${region}.api.aws/v1`,
      api: "openai-completions",
      auth: "api-key",
      apiKey: "env:AWS_BEARER_TOKEN_BEDROCK",
    });
    const fullThinking = { off: "low", minimal: "low", xhigh: "xhigh", max: "max" };
    for (const [id, cost, thinkingLevelMap] of [
      ["claude-opus-5", [5, 25, 0.5, 6.25], { xhigh: "xhigh", max: "max" }],
      ["claude-sonnet-5", [2, 10, 0.2, 2.5], fullThinking],
      ["claude-mythos-5", [10, 50, 1, 12.5], fullThinking],
      ["claude-mythos-preview", undefined, undefined],
    ] as const) {
      expect(provider?.models?.find((model) => model.id === `anthropic.${id}`)).toMatchObject({
        api: "anthropic-messages",
        reasoning: true,
        params: { canonicalModelId: id },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        input: ["text", "image"],
        ...(cost
          ? { cost: { input: cost[0], output: cost[1], cacheRead: cost[2], cacheWrite: cost[3] } }
          : {}),
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      });
    }
    const opus = provider?.models?.find((model) => model.id === "anthropic.claude-opus-4-7");
    expect(opus).toMatchObject({ api: "anthropic-messages", reasoning: false });
    expect(opus).not.toHaveProperty("baseUrl");
  });

  it("retries identical IAM failures while logging once per region", async () => {
    getTokenProviderMock.mockImplementation(() => {
      throw new Error("no credentials");
    });

    for (const region of ["us-east-1", "us-east-1", "us-west-2"]) {
      await expect(resolveProvider({ env: { AWS_REGION: region } })).resolves.toBeNull();
    }

    expect(getTokenProviderMock).toHaveBeenCalledTimes(3);
    expect(discoveryDebugSpy.mock.calls).toEqual([
      ["Mantle IAM token generation unavailable", { region: "us-east-1", error: "no credentials" }],
      ["Mantle IAM token generation unavailable", { region: "us-west-2", error: "no credentials" }],
    ]);
  });

  it("uses a generated IAM token when no explicit token is set", async () => {
    fetchMock.mockResolvedValue(modelResponse("openai.gpt-oss-120b"));
    const provider = await resolveProvider({ env: { AWS_REGION: "ap-southeast-3" } });

    expect(provider?.apiKey).toBe(MANTLE_IAM_TOKEN_MARKER);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://bedrock-mantle.ap-southeast-3.api.aws/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer synthetic-runtime-token" }),
      }),
    );
  });

  it.each([
    { state: "cached", now: 1801000, expiresAt: 7201000 },
    { state: "cold", now: 5000, expiresAt: 7205000 },
    { state: "invalid clock", now: Number.NaN, expiresAt: undefined },
  ])("resolves runtime IAM auth with $state state", async ({ state, now: at, expiresAt }) => {
    if (state === "cached") {
      now = 1000;
      await generateBearerTokenFromIam({ region: testRegion });
    }
    now = at;
    const resolved = await resolveMantleRuntimeBearerToken({
      apiKey: MANTLE_IAM_TOKEN_MARKER,
      env: { AWS_REGION: testRegion },
    });
    expect(resolved).toEqual({
      apiKey: "synthetic-runtime-token",
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });
});
