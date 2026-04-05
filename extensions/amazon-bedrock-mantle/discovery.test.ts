import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverMantleModels,
  mergeImplicitMantleProvider,
  resetMantleDiscoveryCacheForTest,
  resolveMantleBearerToken,
  resolveImplicitMantleProvider,
} from "./api.js";

describe("bedrock mantle discovery", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    resetMantleDiscoveryCacheForTest();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // Bearer token resolution
  // ---------------------------------------------------------------------------

  it("resolves bearer token from AWS_BEARER_TOKEN_BEDROCK", () => {
    expect(
      resolveMantleBearerToken({
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key-abc123", // pragma: allowlist secret
      } as NodeJS.ProcessEnv),
    ).toBe("bedrock-api-key-abc123");
  });

  it("returns undefined when no bearer token env var is set", () => {
    expect(resolveMantleBearerToken({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("trims whitespace from bearer token", () => {
    expect(
      resolveMantleBearerToken({
        AWS_BEARER_TOKEN_BEDROCK: "  my-token  ", // pragma: allowlist secret
      } as NodeJS.ProcessEnv),
    ).toBe("my-token");
  });

  // ---------------------------------------------------------------------------
  // Model discovery
  // ---------------------------------------------------------------------------

  it("discovers models from Mantle /v1/models endpoint sorted by id", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "openai.gpt-oss-120b", object: "model", owned_by: "openai" },
          { id: "anthropic.claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
          { id: "mistral.devstral-2-123b", object: "model", owned_by: "mistral" },
        ],
      }),
    });

    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(models).toHaveLength(3);
    // Models should be sorted alphabetically by id
    expect(models[0]).toMatchObject({
      id: "anthropic.claude-sonnet-4-6",
      name: "anthropic.claude-sonnet-4-6",
      reasoning: false,
      input: ["text"],
    });
    expect(models[1]).toMatchObject({
      id: "mistral.devstral-2-123b",
      reasoning: false,
    });
    expect(models[2]).toMatchObject({
      id: "openai.gpt-oss-120b",
      reasoning: true, // GPT-OSS 120B supports reasoning
    });

    // Verify correct endpoint and auth header
    expect(mockFetch).toHaveBeenCalledWith(
      "https://bedrock-mantle.us-east-1.api.aws/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
  });

  it("infers reasoning support from model IDs", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "moonshotai.kimi-k2-thinking", object: "model" },
          { id: "openai.gpt-oss-120b", object: "model" },
          { id: "openai.gpt-oss-safeguard-120b", object: "model" },
          { id: "deepseek.v3.2", object: "model" },
          { id: "mistral.mistral-large-3-675b-instruct", object: "model" },
        ],
      }),
    });

    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["moonshotai.kimi-k2-thinking"]?.reasoning).toBe(true);
    expect(byId["openai.gpt-oss-120b"]?.reasoning).toBe(true);
    expect(byId["openai.gpt-oss-safeguard-120b"]?.reasoning).toBe(true);
    expect(byId["deepseek.v3.2"]?.reasoning).toBe(false);
    expect(byId["mistral.mistral-large-3-675b-instruct"]?.reasoning).toBe(false);
  });

  it("returns empty array on permission error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(models).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(models).toEqual([]);
  });

  it("filters out models with empty IDs", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "anthropic.claude-sonnet-4-6", object: "model" },
          { id: "", object: "model" },
          { id: "  ", object: "model" },
        ],
      }),
    });

    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("anthropic.claude-sonnet-4-6");
  });

  // ---------------------------------------------------------------------------
  // Discovery caching
  // ---------------------------------------------------------------------------

  it("returns cached models on subsequent calls within refresh interval", async () => {
    let now = 1000000;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
      }),
    });

    // First call — hits the network
    const first = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
    });
    expect(first).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call within refresh interval — uses cache
    now += 60_000; // 1 minute later
    const second = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
    });
    expect(second).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No additional fetch

    // Third call after refresh interval — re-fetches
    now += 3600_000; // 1 hour later
    const third = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
    });
    expect(third).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2); // Re-fetched
  });

  it("returns stale cache on fetch failure", async () => {
    let now = 1000000;
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
        }),
      })
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    // First call — succeeds
    await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
    });

    // Second call after expiry — fails but returns stale cache
    now += 7200_000;
    const stale = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]?.id).toBe("anthropic.claude-sonnet-4-6");
  });

  // ---------------------------------------------------------------------------
  // Implicit provider resolution
  // ---------------------------------------------------------------------------

  it("resolves implicit provider when bearer token is set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
      }),
    });

    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // pragma: allowlist secret
        AWS_REGION: "us-east-1",
      } as NodeJS.ProcessEnv,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(provider).not.toBeNull();
    expect(provider?.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
    expect(provider?.api).toBe("openai-completions");
    expect(provider?.auth).toBe("api-key");
    expect(provider?.apiKey).toBe("env:AWS_BEARER_TOKEN_BEDROCK");
    expect(provider?.models).toHaveLength(1);
  });

  it("returns null when no bearer token is available", async () => {
    const provider = await resolveImplicitMantleProvider({
      env: {} as NodeJS.ProcessEnv,
    });

    expect(provider).toBeNull();
  });

  it("does not infer Mantle auth from plain IAM env vars alone", async () => {
    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_PROFILE: "default",
        AWS_REGION: "us-east-1",
      } as NodeJS.ProcessEnv,
    });

    expect(provider).toBeNull();
  });

  it("returns null for unsupported regions", async () => {
    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // pragma: allowlist secret
        AWS_REGION: "af-south-1",
      } as NodeJS.ProcessEnv,
    });

    expect(provider).toBeNull();
  });

  it("defaults to us-east-1 when no region is set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "openai.gpt-oss-120b", object: "model" }] }),
    });

    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(provider?.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://bedrock-mantle.us-east-1.api.aws/v1/models",
      expect.anything(),
    );
  });

  // ---------------------------------------------------------------------------
  // Provider merging
  // ---------------------------------------------------------------------------

  it("merges implicit models when existing provider has empty models", () => {
    const result = mergeImplicitMantleProvider({
      existing: {
        baseUrl: "https://custom.example.com/v1",
        models: [],
      },
      implicit: {
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
      },
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
      implicit: {
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
        api: "openai-completions",
        auth: "api-key",
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
      },
    });

    expect(result.models?.map((m) => m.id)).toEqual(["custom-model"]);
  });
});
