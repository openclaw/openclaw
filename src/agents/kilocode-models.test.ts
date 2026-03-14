import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  buildKilocodeModelsUrl,
  discoverKilocodeModels,
  KILOCODE_MODELS_URL,
} from "./kilocode-models.js";

// discoverKilocodeModels checks for VITEST env and returns static catalog,
// so we need to temporarily unset it to test the fetch path.

function makeGatewayModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "anthropic/claude-sonnet-4",
    name: "Anthropic: Claude Sonnet 4",
    created: 1700000000,
    description: "A model",
    context_length: 200000,
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      tokenizer: "Claude",
    },
    top_provider: {
      is_moderated: false,
      max_completion_tokens: 8192,
    },
    pricing: {
      prompt: "0.000003",
      completion: "0.000015",
      input_cache_read: "0.0000003",
      input_cache_write: "0.00000375",
    },
    supported_parameters: ["max_tokens", "temperature", "tools", "reasoning"],
    ...overrides,
  };
}

function makeAutoModel(overrides: Record<string, unknown> = {}) {
  return makeGatewayModel({
    id: "kilo/auto",
    name: "Kilo: Auto",
    context_length: 1000000,
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      tokenizer: "Other",
    },
    top_provider: {
      is_moderated: false,
      max_completion_tokens: 128000,
    },
    pricing: {
      prompt: "0.000005",
      completion: "0.000025",
    },
    supported_parameters: ["max_tokens", "temperature", "tools", "reasoning", "include_reasoning"],
    ...overrides,
  });
}

async function withFetchPathTest(
  mockFetch: ReturnType<typeof vi.fn>,
  runAssertions: () => Promise<void>,
) {
  const origNodeEnv = process.env.NODE_ENV;
  const origVitest = process.env.VITEST;
  delete process.env.NODE_ENV;
  delete process.env.VITEST;

  vi.stubGlobal("fetch", mockFetch);

  try {
    await runAssertions();
  } finally {
    if (origNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = origNodeEnv;
    }
    if (origVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = origVitest;
    }
    vi.unstubAllGlobals();
  }
}

describe("buildKilocodeModelsUrl", () => {
  it("returns the default models URL when no org ID is provided", () => {
    expect(buildKilocodeModelsUrl()).toBe(KILOCODE_MODELS_URL);
    expect(buildKilocodeModelsUrl(undefined)).toBe(KILOCODE_MODELS_URL);
  });

  it("returns an org-scoped URL when an org ID is provided", () => {
    const url = buildKilocodeModelsUrl("org-abc-123");
    expect(url).toBe("https://api.kilo.ai/api/organizations/org-abc-123/models");
  });

  it("strips the gateway segment and builds the correct org URL", () => {
    const url = buildKilocodeModelsUrl("test-org");
    expect(url).toContain("/api/organizations/test-org/models");
    expect(url).not.toContain("/gateway/");
  });
});

describe("discoverKilocodeModels", () => {
  it("returns static catalog in test environment", async () => {
    // Default vitest env — should return static catalog without fetching
    const models = await discoverKilocodeModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === "kilo/auto")).toBe(true);
  });

  it("static catalog has correct defaults for kilo/auto", async () => {
    const models = await discoverKilocodeModels();
    const auto = models.find((m) => m.id === "kilo/auto");
    expect(auto).toBeDefined();
    expect(auto?.name).toBe("Kilo Auto");
    expect(auto?.reasoning).toBe(true);
    expect(auto?.input).toEqual(["text", "image"]);
    expect(auto?.contextWindow).toBe(1000000);
    expect(auto?.maxTokens).toBe(128000);
    expect(auto?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("discoverKilocodeModels: org-scoped URL", () => {
  const envSnapshot = captureEnv(["KILOCODE_ORG_ID"]);

  afterEach(() => {
    envSnapshot.restore();
  });

  it("uses org-scoped URL when KILOCODE_ORG_ID env var is set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeAutoModel()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      process.env.KILOCODE_ORG_ID = "org-xyz-789";
      const models = await discoverKilocodeModels();
      expect(models.length).toBeGreaterThan(0);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.kilo.ai/api/organizations/org-xyz-789/models",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
    });
  });

  it("uses default URL when KILOCODE_ORG_ID is not set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeAutoModel()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      delete process.env.KILOCODE_ORG_ID;
      await discoverKilocodeModels();
      expect(mockFetch).toHaveBeenCalledWith(
        KILOCODE_MODELS_URL,
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
    });
  });

  it("uses org-scoped URL from providerConfig.organizationId (P2 fix)", async () => {
    // Org ID from provider config should take precedence over env var and be used
    // to build the org-scoped endpoint URL.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeAutoModel()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      delete process.env.KILOCODE_ORG_ID;
      await discoverKilocodeModels(undefined, { organizationId: "config-org-123" });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.kilo.ai/api/organizations/config-org-123/models",
        expect.any(Object),
      );
    });
  });

  it("providerConfig.organizationId takes precedence over KILOCODE_ORG_ID env var (P2 fix)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeAutoModel()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      process.env.KILOCODE_ORG_ID = "env-org-456";
      await discoverKilocodeModels(undefined, { organizationId: "config-org-123" });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.kilo.ai/api/organizations/config-org-123/models",
        expect.any(Object),
      );
    });
  });

  it("sends Authorization Bearer using the provided apiKey for org-scoped requests (P1 fix)", async () => {
    // When both orgId and apiKey are present, the resolved secret (discoveryApiKey)
    // must be sent as the Bearer token — not an opaque marker string.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeAutoModel()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      await discoverKilocodeModels("actual-secret-token", { organizationId: "config-org-123" });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.kilo.ai/api/organizations/config-org-123/models",
        expect.objectContaining({
          headers: {
            Accept: "application/json",
            Authorization: "Bearer actual-secret-token",
          },
        }),
      );
    });
  });
});

describe("discoverKilocodeModels (fetch path)", () => {
  it("parses gateway models with correct pricing conversion", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [makeAutoModel(), makeGatewayModel()],
        }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();

      // Should have fetched from the gateway URL
      expect(mockFetch).toHaveBeenCalledWith(
        KILOCODE_MODELS_URL,
        expect.objectContaining({
          headers: { Accept: "application/json" },
        }),
      );

      // Should have both models
      expect(models.length).toBe(2);

      // Verify the sonnet model pricing (per-token * 1_000_000 = per-1M-token)
      const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
      expect(sonnet).toBeDefined();
      expect(sonnet?.cost.input).toBeCloseTo(3.0); // 0.000003 * 1_000_000
      expect(sonnet?.cost.output).toBeCloseTo(15.0); // 0.000015 * 1_000_000
      expect(sonnet?.cost.cacheRead).toBeCloseTo(0.3); // 0.0000003 * 1_000_000
      expect(sonnet?.cost.cacheWrite).toBeCloseTo(3.75); // 0.00000375 * 1_000_000

      // Verify modality
      expect(sonnet?.input).toEqual(["text", "image"]);

      // Verify reasoning detection
      expect(sonnet?.reasoning).toBe(true);

      // Verify context/tokens
      expect(sonnet?.contextWindow).toBe(200000);
      expect(sonnet?.maxTokens).toBe(8192);
    });
  });

  it("falls back to static catalog on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === "kilo/auto")).toBe(true);
    });
  });

  it("falls back to static catalog on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === "kilo/auto")).toBe(true);
    });
  });

  it("ensures kilo/auto is present even when API doesn't return it", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [makeGatewayModel()], // no kilo/auto
        }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();
      expect(models.some((m) => m.id === "kilo/auto")).toBe(true);
      expect(models.some((m) => m.id === "anthropic/claude-sonnet-4")).toBe(true);
    });
  });

  it("detects text-only models without image modality", async () => {
    const textOnlyModel = makeGatewayModel({
      id: "some/text-model",
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
      supported_parameters: ["max_tokens", "temperature"],
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [textOnlyModel] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();
      const textModel = models.find((m) => m.id === "some/text-model");
      expect(textModel?.input).toEqual(["text"]);
      expect(textModel?.reasoning).toBe(false);
    });
  });

  it("keeps a later valid duplicate when an earlier entry is malformed", async () => {
    const malformedAutoModel = makeAutoModel({
      name: "Broken Kilo Auto",
      pricing: undefined,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [malformedAutoModel, makeAutoModel(), makeGatewayModel()],
        }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();
      const auto = models.find((m) => m.id === "kilo/auto");
      expect(auto).toBeDefined();
      expect(auto?.name).toBe("Kilo: Auto");
      expect(auto?.cost.input).toBeCloseTo(5.0);
      expect(models.some((m) => m.id === "anthropic/claude-sonnet-4")).toBe(true);
    });
  });
});
