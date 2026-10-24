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
  resolveImplicitMantleProvider,
  resolveMantleRuntimeBearerToken,
} = await import("./api.js");

type TokenProviderFactory = typeof import("@aws/bedrock-token-generator").getTokenProvider;

type DiscoveryDependencies = {
  fetchFn?: typeof fetch;
  now?: () => number;
  tokenProviderFactory?: TokenProviderFactory;
};

function useDiscoveryDependencies(params: DiscoveryDependencies) {
  if (params.fetchFn) {
    vi.stubGlobal("fetch", params.fetchFn);
  }
  if (params.now) {
    vi.spyOn(Date, "now").mockImplementation(params.now);
  }
  if (params.tokenProviderFactory) {
    getTokenProviderMock.mockImplementation(params.tokenProviderFactory);
  }
}

function withDependencies<P, R>(run: (params: P) => R) {
  return (params: P & DiscoveryDependencies) => {
    useDiscoveryDependencies(params);
    return run(params);
  };
}

const discoverModels = withDependencies(discoverMantleModels);
const resolveProvider = withDependencies(resolveImplicitMantleProvider);
const resolveRuntime = withDependencies(resolveMantleRuntimeBearerToken);

function modelResponse(...ids: string[]) {
  return Response.json({ data: ids.map((id) => ({ id })) });
}

function modelFetch(...ids: string[]) {
  return vi.fn<typeof fetch>().mockResolvedValue(modelResponse(...ids));
}

describe("bedrock mantle discovery", () => {
  let testRegionIndex = 0;
  let testRegion = "";

  function generateToken(tokenProviderFactory: TokenProviderFactory, now: number) {
    useDiscoveryDependencies({ tokenProviderFactory, now: () => now });
    return generateBearerTokenFromIam({ region: testRegion });
  }

  function discover(
    fetchFn: typeof fetch,
    overrides: Partial<Parameters<typeof discoverModels>[0]> = {},
  ) {
    return discoverModels({
      region: testRegion,
      bearerToken: "test-token",
      fetchFn,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    catalogTransport.lookup
      .mockReset()
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    catalogTransport.releases.length = 0;
    getTokenProviderMock.mockReset();
    discoveryDebugSpy.mockClear();
    testRegion = `test-region-${++testRegionIndex}`;
  });

  afterEach(() => {
    try {
      for (const release of catalogTransport.releases) {
        expect(release).toHaveBeenCalledOnce();
      }
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("caches generated IAM tokens within TTL", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-cached"); // pragma: allowlist secret
    const tokenProviderFactory = vi.fn(() => tokenProvider);
    const token = await generateToken(tokenProviderFactory, 1000);
    expect(await generateToken(tokenProviderFactory, 1801000)).toEqual(token);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
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
    const tokenProviderFactory = vi.fn(() => {
      throw new Error("rejected discovery should not generate a token");
    });
    await expect(resolveProvider({ env, pluginConfig, tokenProviderFactory })).resolves.toBeNull();
    expect(tokenProviderFactory).not.toHaveBeenCalled();
  });

  it("infers reasoning support from model IDs", async () => {
    const expected = {
      "moonshotai.kimi-k2-thinking": true,
      "openai.gpt-oss-120b": true,
      "openai.gpt-oss-safeguard-120b": true,
      "deepseek.v3.2": false,
      "mistral.mistral-large-3-675b-instruct": false,
    };
    const models = await discover(modelFetch(...Object.keys(expected)));
    expect(Object.fromEntries(models.map((m) => [m.id, m.reasoning]))).toEqual(expected);
  });

  it("aborts Mantle discovery when its request deadline expires", async () => {
    vi.useFakeTimers();
    const started = createDeferred<AbortSignal>();
    const mockFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            throw new Error("Missing discovery abort signal");
          }
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
    try {
      const discovery = discover(mockFetch, { discoveryMode: "strict" });
      const rejected = expect(discovery).rejects.toThrow("request timed out");
      const signal = await started.promise;
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a private DNS destination before sending the bearer credential", async () => {
    catalogTransport.lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const mockFetch = modelFetch();

    await expect(discover(mockFetch, { discoveryMode: "strict" })).rejects.toThrow(
      /private|internal/i,
    );
    expect(catalogTransport.lookup).toHaveBeenCalledWith(`bedrock-mantle.${testRegion}.api.aws`, {
      all: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("bounds successful Mantle model discovery JSON responses", async () => {
    const json = vi.fn(async () => {
      throw new Error("response.json() should not be called");
    });
    const response = new Response("x".repeat(4 * 1024 * 1024 + 1), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(response, "json", { value: json });
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(discover(mockFetch, { discoveryMode: "strict" })).rejects.toThrow(
      "JSON response exceeds 4194304 bytes",
    );
    expect(json).not.toHaveBeenCalled();
  });

  it.each([503, "malformed"])(
    "rejects expired refresh failure %s and recovers",
    async (failure) => {
      let now = 1000000;
      const mockFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(modelResponse("anthropic.claude-sonnet-4-6"))
        .mockImplementationOnce(async () =>
          Response.json({}, { status: failure === 503 ? 503 : 200 }),
        )
        .mockResolvedValueOnce(modelResponse("openai.gpt-oss-120b"));

      await discover(mockFetch, { now: () => now });

      now += 7200_000;
      const refresh = () => discover(mockFetch, { discoveryMode: "strict", now: () => now });
      await expect(refresh()).rejects.toThrow();
      await expect(refresh()).resolves.toMatchObject([{ id: "openai.gpt-oss-120b" }]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    },
  );

  it("scopes fresh catalogs to the region and actual bearer credential", async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(modelResponse("first-account"))
      .mockResolvedValueOnce(modelResponse("second-account"))
      .mockResolvedValueOnce(modelResponse("second-region"));
    for (const [region, bearerToken, id] of [
      [testRegion, "first-token", "first-account"],
      [testRegion, "second-token", "second-account"],
      [`${testRegion}-other`, "second-token", "second-region"],
    ] as const) {
      await expect(
        discoverModels({ region, bearerToken, fetchFn: mockFetch }),
      ).resolves.toMatchObject([{ id }]);
    }
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("preserves the strict empty resolver contract without IAM generation", async () => {
    const fetchFn = modelFetch();
    const tokenProviderFactory = vi.fn(() => {
      throw new Error("Explicit bearer takes precedence");
    });
    const params = {
      env: {
        AWS_REGION: "eu-south-1",
        AWS_BEARER_TOKEN_BEDROCK: "empty-catalog-strict",
      },
      discoveryMode: "strict" as const,
      fetchFn,
      tokenProviderFactory,
    };
    await expect(resolveProvider(params)).resolves.toMatchObject({ models: [] });
    await expect(resolveProvider(params)).resolves.toMatchObject({ models: [] });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(tokenProviderFactory).not.toHaveBeenCalled();
  });

  it("preserves advisory failure defaults without sharing stale rows across credentials", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(modelResponse("public-model"))
      .mockRejectedValue(new Error("offline"));
    const params = { region: testRegion, bearerToken: "first", fetchFn };
    const first = await discoverModels({ ...params, now: () => 1000 });
    await expect(discoverModels({ ...params, now: () => 7201000 })).resolves.toEqual(first);
    await expect(
      discoverModels({ ...params, discoveryMode: "strict", now: () => 7201000 }),
    ).rejects.toThrow("offline");
    await expect(
      discoverModels({ ...params, bearerToken: "second", now: () => 7201000 }),
    ).resolves.toEqual([]);
    await expect(
      resolveProvider({
        env: { AWS_REGION: "us-east-2", AWS_BEARER_TOKEN_BEDROCK: "public-implicit-failure" },
        fetchFn,
      }),
    ).resolves.toBeNull();
  });

  it.each([
    { region: "ap-northeast-1", env: { AWS_REGION: "ap-northeast-1" }, modelId: "openai.gpt-5.5" },
    { region: "us-east-1", env: {}, modelId: "openai.gpt-5.6-luna" },
  ])("resolves the explicit bearer provider in $region", async ({ region, env, modelId }) => {
    // This catalog includes the promotional contract before the September pricing cutover.
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 7, 31));
    const fetchFn = modelFetch("anthropic.claude-sonnet-4-6", modelId, "openai.gpt-oss-120b");
    const provider = await resolveProvider({
      env: { ...env, AWS_BEARER_TOKEN_BEDROCK: "my-token" },
      fetchFn,
    });
    expect(provider).toMatchObject({
      baseUrl: `https://bedrock-mantle.${region}.api.aws/v1`,
      api: "openai-completions",
      auth: "api-key",
      apiKey: "env:AWS_BEARER_TOKEN_BEDROCK",
    });
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      `https://bedrock-mantle.${region}.api.aws/v1/models`,
      expect.any(Object),
    );
    expect(provider?.models).toHaveLength(8);
    expect(provider?.models.find((model) => model.id === modelId)).toMatchObject({
      api: "openai-responses",
      baseUrl: `https://bedrock-mantle.${region}.api.aws/openai/v1`,
    });
    const oss = provider?.models.find((model) => model.id === "openai.gpt-oss-120b");
    expect(oss?.api ?? provider?.api).toBe("openai-completions");
    expect(oss).not.toHaveProperty("baseUrl");
    function expectClaude(id: string, metadata: object = {}) {
      expect(provider?.models?.find((model) => model.id === `anthropic.${id}`)).toMatchObject({
        api: "anthropic-messages",
        reasoning: true,
        params: { canonicalModelId: id },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        ...metadata,
      });
    }
    const fullThinking = { off: "low", minimal: "low", xhigh: "xhigh", max: "max" };
    expectClaude("claude-opus-5", {
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
    });
    expectClaude("claude-sonnet-5", {
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      thinkingLevelMap: fullThinking,
      input: ["text", "image"],
    });
    expectClaude("claude-mythos-5", {
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      thinkingLevelMap: fullThinking,
    });
    expectClaude("claude-mythos-preview");
    const opus = provider?.models?.find((model) => model.id === "anthropic.claude-opus-4-7");
    expect(opus).toMatchObject({ api: "anthropic-messages", reasoning: false });
    expect(opus).not.toHaveProperty("baseUrl");
  });

  it("retries identical IAM failures while logging once per region", async () => {
    const tokenProviderFactory = vi.fn(() => {
      throw new Error("no credentials");
    });

    for (const region of ["us-east-1", "us-east-1", "us-west-2"]) {
      await expect(
        resolveProvider({
          env: { AWS_REGION: region },
          tokenProviderFactory,
        }),
      ).resolves.toBeNull();
    }

    expect(tokenProviderFactory).toHaveBeenCalledTimes(3);
    expect(discoveryDebugSpy.mock.calls).toEqual([
      ["Mantle IAM token generation unavailable", { region: "us-east-1", error: "no credentials" }],
      ["Mantle IAM token generation unavailable", { region: "us-west-2", error: "no credentials" }],
    ]);
  });

  it("uses a generated IAM token when no explicit token is set", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-iam"); // pragma: allowlist secret
    const tokenProviderFactory = vi.fn(() => tokenProvider);
    const mockFetch = modelFetch("openai.gpt-oss-120b");

    const provider = await resolveProvider({
      env: {
        AWS_PROFILE: "default",
        AWS_REGION: "ap-southeast-3",
      },
      fetchFn: mockFetch,
      tokenProviderFactory,
    });

    expect(provider?.apiKey).toBe(MANTLE_IAM_TOKEN_MARKER);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://bedrock-mantle.ap-southeast-3.api.aws/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer bedrock-api-key-iam" }),
      }),
    );
  });

  it.each([
    { state: "cached", now: 2000, expiresAt: 7201000 },
    { state: "cold", now: 5000, expiresAt: 7205000 },
    { state: "invalid clock", now: Number.NaN, expiresAt: undefined },
  ])("resolves runtime IAM auth with $state state", async ({ state, now, expiresAt }) => {
    const tokenProvider = vi.fn(async () => "synthetic-runtime-token");
    const tokenProviderFactory = vi.fn(() => tokenProvider);
    if (state === "cached") {
      await generateToken(tokenProviderFactory, 1000);
    }
    const resolved = await resolveRuntime({
      apiKey: MANTLE_IAM_TOKEN_MARKER,
      env: { AWS_REGION: testRegion },
      now: () => now,
      tokenProviderFactory,
    });
    expect(resolved).toEqual({
      apiKey: "synthetic-runtime-token",
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });
});
