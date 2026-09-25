import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

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
  getCachedIamToken,
  MANTLE_IAM_TOKEN_MARKER,
  mergeImplicitMantleProvider,
  resolveImplicitMantleProvider,
  resolveMantleBearerToken,
  resolveMantleRuntimeBearerToken,
} = await import("./api.js");

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
    tokenProviderFactory: NonNullable<
      Parameters<typeof generateBearerTokenFromIam>[0]["tokenProviderFactory"]
    >,
    now?: number,
    region = testRegion,
  ) {
    return generateBearerTokenFromIam({
      region,
      tokenProviderFactory,
      ...(now === undefined ? {} : { now: () => now }),
    });
  }

  function discover(
    fetchFn: typeof fetch,
    overrides: Partial<Parameters<typeof discoverMantleModels>[0]> = {},
  ) {
    return discoverMantleModels({
      region: testRegion,
      bearerToken: "test-token",
      fetchFn,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    discoveryDebugSpy.mockClear();
    discoveryLoggerState.debugEnabled = true;
    testRegion = `test-region-${++testRegionIndex}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when no bearer token env var is set", () => {
    expect(resolveMantleBearerToken({})).toBeUndefined();
  });

  it("trims whitespace from bearer token", () => {
    expect(
      resolveMantleBearerToken({
        AWS_BEARER_TOKEN_BEDROCK: "  my-token  ", // pragma: allowlist secret
      }),
    ).toBe("my-token");
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

  it("does not reuse an IAM token across regions", async () => {
    const tokenProvider = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("bedrock-api-key-east") // pragma: allowlist secret
      .mockResolvedValueOnce("bedrock-api-key-west"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);
    const otherRegion = `${testRegion}-other`;

    const east = await generateToken(tokenProviderFactory, 1000);
    const west = await generateToken(tokenProviderFactory, 2000, otherRegion);

    expect(east).toBe("bedrock-api-key-east");
    expect(west).toBe("bedrock-api-key-west");
    expect(tokenProviderFactory).toHaveBeenNthCalledWith(1, {
      region: testRegion,
      expiresInSeconds: 7200,
    });
    expect(tokenProviderFactory).toHaveBeenNthCalledWith(2, {
      region: otherRegion,
      expiresInSeconds: 7200,
    });
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });

  it("logs a new IAM token failure after the credential chain recovers", async () => {
    const tokenProviderFactory = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("same failure");
      })
      .mockImplementationOnce(() => async () => "recovered-token")
      .mockImplementationOnce(() => {
        throw new Error("same failure");
      });

    await generateToken(tokenProviderFactory, 0);
    await generateToken(tokenProviderFactory, 1);
    await generateToken(tokenProviderFactory, 7200_001);

    expect(discoveryDebugSpy).toHaveBeenCalledTimes(2);
    expect(discoveryDebugSpy).toHaveBeenNthCalledWith(
      1,
      "Mantle IAM token generation unavailable",
      { region: testRegion, error: "same failure" },
    );
    expect(discoveryDebugSpy).toHaveBeenNthCalledWith(
      2,
      "Mantle IAM token generation unavailable",
      { region: testRegion, error: "same failure" },
    );
  });

  it.each(["older", "newer"] as const)(
    "ignores the %s failure that started before an IAM token succeeds",
    async (failureOrder) => {
      let rejectFailure!: (error: Error) => void;
      const failure = new Promise<string>((_resolve, reject) => {
        rejectFailure = reject;
      });
      let resolveSuccess!: (token: string) => void;
      const success = new Promise<string>((resolve) => {
        resolveSuccess = resolve;
      });
      const tokenProviderFactory = vi
        .fn()
        .mockImplementationOnce(() => () => (failureOrder === "older" ? failure : success))
        .mockImplementationOnce(() => () => (failureOrder === "older" ? success : failure))
        .mockImplementationOnce(() => {
          throw new Error("same failure");
        });
      const first = generateToken(tokenProviderFactory, 0);
      const second = generateToken(tokenProviderFactory, 1);
      const [pendingFailure, pendingSuccess] =
        failureOrder === "older" ? [first, second] : [second, first];

      resolveSuccess("recovered-token");
      await expect(pendingSuccess).resolves.toBe("recovered-token");
      rejectFailure(new Error("same failure"));
      await expect(pendingFailure).resolves.toBeUndefined();
      expect(discoveryDebugSpy).not.toHaveBeenCalled();

      await generateToken(tokenProviderFactory, 7_200_001);
      expect(discoveryDebugSpy).toHaveBeenCalledOnce();
      expect(discoveryDebugSpy).toHaveBeenCalledWith("Mantle IAM token generation unavailable", {
        region: testRegion,
        error: "same failure",
      });
    },
  );

  it("logs when the IAM token failure cause changes before recovery", async () => {
    const tokenProviderFactory = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("credentials unavailable");
      })
      .mockImplementationOnce(() => {
        throw new Error("credentials expired");
      })
      .mockImplementationOnce(() => {
        throw new Error("credentials expired");
      });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await generateToken(tokenProviderFactory);
    }

    expect(tokenProviderFactory).toHaveBeenCalledTimes(3);
    expect(discoveryDebugSpy.mock.calls).toEqual([
      [
        "Mantle IAM token generation unavailable",
        { region: testRegion, error: "credentials unavailable" },
      ],
      [
        "Mantle IAM token generation unavailable",
        { region: testRegion, error: "credentials expired" },
      ],
    ]);
  });

  it("logs an ongoing IAM token failure after debug becomes enabled", async () => {
    const tokenProviderFactory = vi.fn(() => {
      throw new Error("no credentials");
    });

    discoveryLoggerState.debugEnabled = false;
    await generateToken(tokenProviderFactory);
    expect(discoveryDebugSpy).not.toHaveBeenCalled();

    discoveryLoggerState.debugEnabled = true;
    await generateToken(tokenProviderFactory);

    expect(tokenProviderFactory).toHaveBeenCalledTimes(2);
    expect(discoveryDebugSpy).toHaveBeenCalledOnce();
    expect(discoveryDebugSpy).toHaveBeenCalledWith("Mantle IAM token generation unavailable", {
      region: testRegion,
      error: "no credentials",
    });
  });

  it("skips IAM token generation when plugin discovery is disabled", async () => {
    const tokenProviderFactory = vi.fn(() => {
      throw new Error("disabled discovery should not generate a token");
    });

    await expect(
      resolveImplicitMantleProvider({
        env: { AWS_REGION: "us-east-1" },
        pluginConfig: { discovery: { enabled: false } },
        tokenProviderFactory,
      }),
    ).resolves.toBeNull();

    expect(tokenProviderFactory).not.toHaveBeenCalled();
  });

  it("getCachedIamToken returns cached token when valid", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-cached-token"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    await generateToken(tokenProviderFactory);

    expect(getCachedIamToken(testRegion)).toBe("bedrock-cached-token");
  });

  it("getCachedIamToken returns undefined when cache is expired", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-expired-token"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    await generateToken(tokenProviderFactory, 1000);
    expect(getCachedIamToken(testRegion)).toBeUndefined();
  });

  it("does not cache generated IAM tokens when ttl expiry overflows", async () => {
    const tokenProvider = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("bedrock-overflow-token-1") // pragma: allowlist secret
      .mockResolvedValueOnce("bedrock-overflow-token-2"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    await expect(generateToken(tokenProviderFactory, 8_640_000_000_000_000)).resolves.toBe(
      "bedrock-overflow-token-1",
    );
    expect(getCachedIamToken(testRegion)).toBeUndefined();

    await expect(generateToken(tokenProviderFactory, 8_640_000_000_000_000)).resolves.toBe(
      "bedrock-overflow-token-2",
    );
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });

  it("discovers models from Mantle /v1/models endpoint sorted by id", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      modelDiscoveryResponse({
        data: [
          { id: "openai.gpt-oss-120b", object: "model", owned_by: "openai" },
          { id: "anthropic.claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
          { id: "mistral.devstral-2-123b", object: "model", owned_by: "mistral" },
        ],
      }),
    );

    const models = await discover(mockFetch);

    expect(models).toHaveLength(3);
    expect(models[0]?.id).toBe("anthropic.claude-sonnet-4-6");
    expect(models[0]?.name).toBe("anthropic.claude-sonnet-4-6");
    expect(models[0]?.reasoning).toBe(false);
    expect(models[0]?.input).toEqual(["text"]);
    expect(models[1]?.id).toBe("mistral.devstral-2-123b");
    expect(models[1]?.reasoning).toBe(false);
    expect(models[2]?.id).toBe("openai.gpt-oss-120b");
    expect(models[2]?.reasoning).toBe(true); // GPT-OSS 120B supports reasoning

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      `https://bedrock-mantle.${testRegion}.api.aws/v1/models`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
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

  it("rejects permission failures and releases the response body", async () => {
    const response = modelDiscoveryResponse(
      { error: "forbidden" },
      { status: 403, statusText: "Forbidden" },
    );
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(discover(mockFetch, { discoveryMode: "strict" })).rejects.toMatchObject({
      status: 403,
    });
    expect(response.bodyUsed).toBe(true);
  });

  it("filters out models with empty IDs", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      modelDiscoveryResponse({
        data: [
          { id: "anthropic.claude-sonnet-4-6", object: "model" },
          { id: "", object: "model" },
          { id: "  ", object: "model" },
        ],
      }),
    );

    const models = await discover(mockFetch);

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("anthropic.claude-sonnet-4-6");
  });

  it("passes a timeout signal to Mantle model discovery fetches", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      modelDiscoveryResponse({
        data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
      }),
    );

    await discover(mockFetch);

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
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

  it("rejects invalid UTF-8 model discovery responses", async () => {
    const prefix = new TextEncoder().encode('{"data":[{"id":"anthropic.');
    const suffix = new TextEncoder().encode('.model","object":"model"}]}');
    const invalidBody = new Uint8Array([...prefix, 0xff, ...suffix]);
    const mockFetch = vi.fn<typeof fetch>(
      async () => new Response(invalidBody, { headers: { "content-type": "application/json" } }),
    );

    await expect(discover(mockFetch, { discoveryMode: "strict" })).rejects.toThrow();
  });

  it("returns cached models on subsequent calls within refresh interval", async () => {
    let now = 1000000;
    const mockFetch = vi.fn<typeof fetch>(async () =>
      modelDiscoveryResponse({
        data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
      }),
    );

    const first = await discover(mockFetch, { now: () => now });
    expect(first).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    now += 60_000; // 1 minute later
    const second = await discover(mockFetch, { now: () => now });
    expect(second).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    now += 3600_000; // 1 hour later
    const third = await discover(mockFetch, { now: () => now });
    expect(third).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([503, "network", "malformed", "invalid-json"])(
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
          if (failure === "network") {
            throw new Error("ECONNREFUSED");
          }
          return failure === "invalid-json"
            ? new Response("{")
            : modelDiscoveryResponse({}, { status: failure === 503 ? 503 : 200 });
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
      await expect(discoverMantleModels(params)).rejects.toThrow(
        failure === "network" ? "ECONNREFUSED" : undefined,
      );
      await expect(discoverMantleModels(params)).resolves.toMatchObject([
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
        discoverMantleModels({ region, bearerToken, fetchFn: mockFetch }),
      ).resolves.toMatchObject([{ id }]);
    }
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, "strict"] as const)(
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
      const first = await resolveImplicitMantleProvider(params);
      const second = await resolveImplicitMantleProvider(params);
      if (discoveryMode === "strict") {
        expect(first).toMatchObject({ models: [] });
        expect(second).toMatchObject({ models: [] });
      } else {
        expect(first).toBeNull();
        expect(second).toBeNull();
      }
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
    const first = await discoverMantleModels({ ...params, now: () => 1000 });
    await expect(discoverMantleModels({ ...params, now: () => 7201000 })).resolves.toEqual(first);
    await expect(
      discoverMantleModels({ ...params, discoveryMode: "strict", now: () => 7201000 }),
    ).rejects.toThrow("offline");
    await expect(
      discoverMantleModels({ ...params, bearerToken: "second", now: () => 7201000 }),
    ).resolves.toEqual([]);
    await expect(
      resolveImplicitMantleProvider({
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

    const provider = await resolveImplicitMantleProvider({
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

  it("rolls Claude Sonnet 5 to standard pricing on September 1, 2026", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 1));
    try {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        modelDiscoveryResponse({
          data: [{ id: "anthropic.claude-sonnet-5", object: "model" }],
        }),
      );
      const provider = await resolveImplicitMantleProvider({
        env: {
          AWS_BEARER_TOKEN_BEDROCK: "my-token", // pragma: allowlist secret
          AWS_REGION: "ap-south-1",
        },
        fetchFn: mockFetch,
      });

      expect(
        provider?.models?.find((model) => model.id === "anthropic.claude-sonnet-5")?.cost,
      ).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries identical IAM failures while logging once per region", async () => {
    const tokenProviderFactory = vi.fn(() => {
      throw new Error("no credentials");
    });

    for (const region of ["us-east-1", "us-east-1", "us-west-2"]) {
      await expect(
        resolveImplicitMantleProvider({
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

    const provider = await resolveImplicitMantleProvider({
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

    const resolved = await resolveMantleRuntimeBearerToken({
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

    const resolved = await resolveMantleRuntimeBearerToken({
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

    const resolved = await resolveMantleRuntimeBearerToken({
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

  it("returns null for unsupported regions", async () => {
    const provider = await resolveImplicitMantleProvider({
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

    const provider = await resolveImplicitMantleProvider({
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

  it.each([
    {
      name: "the fallback region when the primary env is blank",
      env: { AWS_REGION: "   ", AWS_DEFAULT_REGION: "eu-west-1" },
      expectedRegion: "eu-west-1",
    },
  ])("uses $name", async ({ env, expectedRegion }) => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        modelDiscoveryResponse({ data: [{ id: "openai.gpt-oss-120b", object: "model" }] }),
      );

    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: MANTLE_IAM_TOKEN_MARKER,
        ...env,
      },
      fetchFn: mockFetch,
    });

    expect(provider?.baseUrl).toBe(`https://bedrock-mantle.${expectedRegion}.api.aws/v1`);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      `https://bedrock-mantle.${expectedRegion}.api.aws/v1/models`,
      expect.any(Object),
    );
  });

  const implicitProvider = {
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
    api: "openai-completions",
    auth: "api-key",
    apiKey: "env:AWS_BEARER_TOKEN_BEDROCK",
    models: [
      {
        id: "openai.gpt-oss-120b",
        name: "GPT-OSS 120B",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      },
    ],
  } satisfies Parameters<typeof mergeImplicitMantleProvider>[0]["implicit"];

  it("merges implicit models when existing provider has empty models", () => {
    const result = mergeImplicitMantleProvider({
      existing: {
        baseUrl: "https://custom.example.com/v1",
        models: [],
      },
      implicit: implicitProvider,
    });

    expect(result.baseUrl).toBe("https://custom.example.com/v1");
    expect(result.models?.map((m) => m.id)).toEqual(["openai.gpt-oss-120b"]);
  });

  it("preserves existing models over implicit ones", () => {
    const result = mergeImplicitMantleProvider({
      existing: {
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
        models: [
          {
            id: "custom-model",
            name: "My Custom Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 64000,
            maxTokens: 8192,
          },
        ],
      },
      implicit: implicitProvider,
    });

    expect(result.models?.map((m) => m.id)).toEqual(["custom-model"]);
  });
});
