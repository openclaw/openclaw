import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

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
const discoveryLoggerState = vi.hoisted(() => ({ debugEnabled: true }));
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
              args[0] === "debug" ? discoveryLoggerState.debugEnabled : logger.isEnabled(...args),
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

function useDiscoveryDependencies(params: {
  fetchFn?: typeof fetch;
  now?: () => number;
  tokenProviderFactory?: TokenProviderFactory;
}) {
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

function discoverWithDependencies(
  params: Parameters<typeof discoverMantleModels>[0] & {
    fetchFn?: typeof fetch;
    now?: () => number;
  },
) {
  useDiscoveryDependencies(params);
  return discoverMantleModels(params);
}

function resolveImplicitWithDependencies(
  params: Parameters<typeof resolveImplicitMantleProvider>[0] & {
    fetchFn?: typeof fetch;
    tokenProviderFactory?: TokenProviderFactory;
  },
) {
  useDiscoveryDependencies(params);
  return resolveImplicitMantleProvider(params);
}

function resolveRuntimeWithDependencies(
  params: Parameters<typeof resolveMantleRuntimeBearerToken>[0] & {
    now?: () => number;
    tokenProviderFactory?: TokenProviderFactory;
  },
) {
  useDiscoveryDependencies(params);
  return resolveMantleRuntimeBearerToken(params);
}

function createTokenProviderFactory(tokenProvider: () => Promise<string>) {
  return vi.fn(() => tokenProvider);
}

function modelDiscoveryResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

describe("bedrock mantle discovery", () => {
  let testRegionIndex = 0;
  let testRegion = "";

  function generateToken(
    tokenProviderFactory: TokenProviderFactory,
    now?: number,
    region = testRegion,
  ) {
    useDiscoveryDependencies({
      tokenProviderFactory,
      ...(now === undefined ? {} : { now: () => now }),
    });
    return generateBearerTokenFromIam({ region });
  }

  function discover(
    fetchFn: typeof fetch,
    overrides: Partial<Parameters<typeof discoverWithDependencies>[0]> = {},
  ) {
    return discoverWithDependencies({
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
    discoveryLoggerState.debugEnabled = true;
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
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);
    let now = 1000;

    const t1 = await generateToken(tokenProviderFactory, now);
    now += 1800_000; // 30 min — within 2hr cache TTL
    const t2 = await generateToken(tokenProviderFactory, now);

    expect(t1).toEqual(t2);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it.each(["older", "newer"] as const)(
    "ignores the %s failure that started before an IAM token succeeds",
    async (failureOrder) => {
      const failure = createDeferred<string>();
      const success = createDeferred<string>();
      const firstStarted = createDeferred<void>();
      const secondStarted = createDeferred<void>();
      getTokenProviderMock
        .mockReturnValueOnce(() => {
          firstStarted.resolve();
          return failureOrder === "older" ? failure.promise : success.promise;
        })
        .mockReturnValueOnce(() => {
          secondStarted.resolve();
          return failureOrder === "older" ? success.promise : failure.promise;
        })
        .mockImplementationOnce(() => {
          throw new Error("same failure");
        });
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const first = generateBearerTokenFromIam({ region: testRegion });
      await firstStarted.promise;
      now = 1;
      const second = generateBearerTokenFromIam({ region: testRegion });
      await secondStarted.promise;
      const [pendingFailure, pendingSuccess] =
        failureOrder === "older" ? [first, second] : [second, first];

      try {
        success.resolve("recovered-token");
        await expect(pendingSuccess).resolves.toBe("recovered-token");
        failure.reject(new Error("same failure"));
        await expect(pendingFailure).resolves.toBeUndefined();
        expect(discoveryDebugSpy).not.toHaveBeenCalled();

        now = 7_200_001;
        await generateBearerTokenFromIam({ region: testRegion });
        expect(discoveryDebugSpy).toHaveBeenCalledOnce();
        expect(discoveryDebugSpy).toHaveBeenCalledWith("Mantle IAM token generation unavailable", {
          region: testRegion,
          error: "same failure",
        });
      } finally {
        success.resolve("recovered-token");
        failure.reject(new Error("same failure"));
        await Promise.allSettled([first, second]);
      }
    },
  );

  it("skips IAM token generation when plugin discovery is disabled", async () => {
    const tokenProviderFactory = vi.fn(() => {
      throw new Error("disabled discovery should not generate a token");
    });

    await expect(
      resolveImplicitWithDependencies({
        env: { AWS_REGION: "us-east-1" },
        pluginConfig: { discovery: { enabled: false } },
        tokenProviderFactory,
      }),
    ).resolves.toBeNull();

    expect(tokenProviderFactory).not.toHaveBeenCalled();
  });

  it("infers reasoning support from model IDs", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      modelDiscoveryResponse({
        data: [
          { id: "moonshotai.kimi-k2-thinking", object: "model" },
          { id: "openai.gpt-oss-120b", object: "model" },
          { id: "openai.gpt-oss-safeguard-120b", object: "model" },
          { id: "deepseek.v3.2", object: "model" },
          { id: "mistral.mistral-large-3-675b-instruct", object: "model" },
        ],
      }),
    );

    const models = await discover(mockFetch);

    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["moonshotai.kimi-k2-thinking"]?.reasoning).toBe(true);
    expect(byId["openai.gpt-oss-120b"]?.reasoning).toBe(true);
    expect(byId["openai.gpt-oss-safeguard-120b"]?.reasoning).toBe(true);
    expect(byId["deepseek.v3.2"]?.reasoning).toBe(false);
    expect(byId["mistral.mistral-large-3-675b-instruct"]?.reasoning).toBe(false);
  });

  it("aborts Mantle discovery when its request deadline expires", async () => {
    vi.useFakeTimers();
    const started = createDeferred<AbortSignal>();
    const mockFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Missing discovery abort signal"));
            return;
          }
          started.resolve(signal);
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("Expected discovery abort to carry an Error"),
              ),
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
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(modelDiscoveryResponse({ data: [] }));

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
        .mockResolvedValueOnce(
          modelDiscoveryResponse({
            data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
          }),
        )
        .mockImplementationOnce(async () => {
          return modelDiscoveryResponse({}, { status: failure === 503 ? 503 : 200 });
        })
        .mockResolvedValueOnce(modelDiscoveryResponse({ data: [{ id: "openai.gpt-oss-120b" }] }));

      await discover(mockFetch, { now: () => now });

      now += 7200_000;
      const params = {
        discoveryMode: "strict" as const,
        region: testRegion,
        bearerToken: "test-token",
        fetchFn: mockFetch,
        now: () => now,
      };
      await expect(discoverWithDependencies(params)).rejects.toThrow();
      await expect(discoverWithDependencies(params)).resolves.toMatchObject([
        { id: "openai.gpt-oss-120b" },
      ]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    },
  );

  it("scopes fresh catalogs to the region and actual bearer credential", async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(modelDiscoveryResponse({ data: [{ id: "first-account" }] }))
      .mockResolvedValueOnce(modelDiscoveryResponse({ data: [{ id: "second-account" }] }))
      .mockResolvedValueOnce(modelDiscoveryResponse({ data: [{ id: "second-region" }] }));
    for (const [region, bearerToken, id] of [
      [testRegion, "first-token", "first-account"],
      [testRegion, "second-token", "second-account"],
      [`${testRegion}-other`, "second-token", "second-region"],
    ] as const) {
      await expect(
        discoverWithDependencies({ region, bearerToken, fetchFn: mockFetch }),
      ).resolves.toMatchObject([{ id }]);
    }
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it.each(["strict"] as const)(
    "preserves the %s empty resolver contract without IAM generation",
    async (discoveryMode) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(modelDiscoveryResponse({ data: [] }));
      const tokenProviderFactory = vi.fn(() => {
        throw new Error("Explicit bearer takes precedence");
      });
      const params = {
        env: {
          AWS_REGION: "eu-south-1",
          AWS_BEARER_TOKEN_BEDROCK: `empty-catalog-${discoveryMode}`,
        },
        discoveryMode,
        fetchFn,
        tokenProviderFactory,
      };
      const first = await resolveImplicitWithDependencies(params);
      const second = await resolveImplicitWithDependencies(params);
      expect(first).toMatchObject({ models: [] });
      expect(second).toMatchObject({ models: [] });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(tokenProviderFactory).not.toHaveBeenCalled();
    },
  );

  it("preserves advisory failure defaults without sharing stale rows across credentials", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(modelDiscoveryResponse({ data: [{ id: "public-model" }] }))
      .mockRejectedValue(new Error("offline"));
    const params = { region: testRegion, bearerToken: "first", fetchFn };
    const first = await discoverWithDependencies({ ...params, now: () => 1000 });
    await expect(discoverWithDependencies({ ...params, now: () => 7201000 })).resolves.toEqual(
      first,
    );
    await expect(
      discoverWithDependencies({ ...params, discoveryMode: "strict", now: () => 7201000 }),
    ).rejects.toThrow("offline");
    await expect(
      discoverWithDependencies({ ...params, bearerToken: "second", now: () => 7201000 }),
    ).resolves.toEqual([]);
    await expect(
      resolveImplicitWithDependencies({
        env: { AWS_REGION: "us-east-2", AWS_BEARER_TOKEN_BEDROCK: "public-implicit-failure" },
        fetchFn,
      }),
    ).resolves.toBeNull();
  });

  it("resolves implicit provider when bearer token is set", async () => {
    // This catalog includes the promotional contract before the September pricing cutover.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 7, 31));
    onTestFinished(() => clock.mockRestore());
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      modelDiscoveryResponse({
        data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
      }),
    );

    const provider = await resolveImplicitWithDependencies({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // pragma: allowlist secret
        AWS_REGION: "ap-northeast-1",
      },
      fetchFn: mockFetch,
    });

    expect(provider?.baseUrl).toBe("https://bedrock-mantle.ap-northeast-1.api.aws/v1");
    expect(provider?.api).toBe("openai-completions");
    expect(provider?.auth).toBe("api-key");
    expect(provider?.apiKey).toBe("env:AWS_BEARER_TOKEN_BEDROCK");
    expect(provider?.models).toHaveLength(6);
    const opus5 = provider?.models?.find((model) => model.id === "anthropic.claude-opus-5");
    expect(opus5).toMatchObject({
      api: "anthropic-messages",
      reasoning: true,
      params: { canonicalModelId: "claude-opus-5" },
      input: ["text", "image"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });
    const sonnet = provider?.models?.find((model) => model.id === "anthropic.claude-sonnet-5");
    expect(sonnet).toMatchObject({
      api: "anthropic-messages",
      reasoning: true,
      params: { canonicalModelId: "claude-sonnet-5" },
      input: ["text", "image"],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    });
    const opus = provider?.models?.find((model) => model.id === "anthropic.claude-opus-4-7");
    expect(opus?.api).toBe("anthropic-messages");
    expect(opus?.reasoning).toBe(false);
    expect(opus).not.toHaveProperty("baseUrl");
    const mythos = provider?.models?.find((model) => model.id === "anthropic.claude-mythos-5");
    expect(mythos).toMatchObject({
      api: "anthropic-messages",
      reasoning: true,
      params: { canonicalModelId: "claude-mythos-5" },
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    });
    const mythosPreview = provider?.models?.find(
      (model) => model.id === "anthropic.claude-mythos-preview",
    );
    expect(mythosPreview).toMatchObject({
      api: "anthropic-messages",
      reasoning: true,
      params: { canonicalModelId: "claude-mythos-preview" },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
  });

  it("retries identical IAM failures while logging once per region", async () => {
    const tokenProviderFactory = vi.fn(() => {
      throw new Error("no credentials");
    });

    for (const region of ["us-east-1", "us-east-1", "us-west-2"]) {
      await expect(
        resolveImplicitWithDependencies({
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
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      modelDiscoveryResponse({
        data: [{ id: "openai.gpt-oss-120b", object: "model" }],
      }),
    );

    const provider = await resolveImplicitWithDependencies({
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

  it("resolves Mantle runtime auth from the cached IAM token marker", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-runtime"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    await generateToken(tokenProviderFactory, 1000);

    const resolved = await resolveRuntimeWithDependencies({
      apiKey: MANTLE_IAM_TOKEN_MARKER,
      env: {
        AWS_REGION: testRegion,
      },
      now: () => 2000,
      tokenProviderFactory,
    });
    expect(resolved?.apiKey).toBe("bedrock-api-key-runtime");
    expect(resolved?.expiresAt).toBe(1000 + 7200_000);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("generates a fresh Mantle runtime IAM token when the cache is cold", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-fresh"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    const resolved = await resolveRuntimeWithDependencies({
      apiKey: MANTLE_IAM_TOKEN_MARKER,
      env: {
        AWS_REGION: testRegion,
      },
      now: () => 5000,
      tokenProviderFactory,
    });
    expect(resolved?.apiKey).toBe("bedrock-api-key-fresh");
    expect(resolved?.expiresAt).toBe(5000 + 7200_000);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("omits Mantle runtime IAM token expiry when the process clock is invalid", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-invalid-clock"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    const resolved = await resolveRuntimeWithDependencies({
      apiKey: MANTLE_IAM_TOKEN_MARKER,
      env: {
        AWS_REGION: testRegion,
      },
      now: () => Number.NaN,
      tokenProviderFactory,
    });
    expect(resolved).toEqual({
      apiKey: "bedrock-api-key-invalid-clock",
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("resolves Mantle runtime auth via ambient aws-sdk authMode without the IAM marker", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-aws-sdk-authmode"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    const resolved = await resolveRuntimeWithDependencies({
      apiKey: "***",
      authMode: "aws-sdk",
      env: {
        AWS_REGION: testRegion,
      },
      now: () => 9000,
      tokenProviderFactory,
    });
    expect(resolved?.apiKey).toBe("bedrock-api-key-aws-sdk-authmode");
    expect(resolved?.expiresAt).toBe(9000 + 7200_000);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("returns the literal apiKey as-is when authMode is not aws-sdk and the IAM marker is absent", async () => {
    const resolved = await resolveRuntimeWithDependencies({
      apiKey: "literal-bearer-value", // pragma: allowlist secret
      authMode: "api-key",
      env: {
        AWS_REGION: testRegion,
      },
    });
    expect(resolved).toEqual({ apiKey: "literal-bearer-value" });
  });

  it("returns null for unsupported regions", async () => {
    const provider = await resolveImplicitWithDependencies({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // pragma: allowlist secret
        AWS_REGION: "af-south-1",
      },
    });

    expect(provider).toBeNull();
  });

  it("defaults to us-east-1 when no region is set", async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        modelDiscoveryResponse({ data: [{ id: "openai.gpt-oss-120b", object: "model" }] }),
      );

    const provider = await resolveImplicitWithDependencies({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // pragma: allowlist secret
      },
      fetchFn: mockFetch,
    });

    expect(provider?.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://bedrock-mantle.us-east-1.api.aws/v1/models",
      expect.any(Object),
    );
  });
});
