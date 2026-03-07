import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSglangDiffusionModels } from "./models-config.providers.js";

describe("SGLang-Diffusion auto-discovery", () => {
  let originalVitest: string | undefined;
  let originalNodeEnv: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    if (originalVitest !== undefined) {
      process.env.VITEST = originalVitest;
    } else {
      delete process.env.VITEST;
    }
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    globalThis.fetch = originalFetch;
    delete process.env.SGLANG_DIFFUSION_API_KEY;
  });

  function setupDiscoveryEnv() {
    originalVitest = process.env.VITEST;
    originalNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    originalFetch = globalThis.fetch;
  }

  it("discovers models from SGLang-Diffusion /v1/models endpoint", async () => {
    setupDiscoveryEnv();
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      if (String(url).includes("/models")) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "black-forest-labs/FLUX.1-dev" }, { id: "Qwen/Qwen-Image" }],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const models = await discoverSglangDiffusionModels("http://127.0.0.1:30000/v1");

    expect(models).toHaveLength(2);
    expect(models[0]).toBe("black-forest-labs/FLUX.1-dev");
    expect(models[1]).toBe("Qwen/Qwen-Image");
  });

  it("returns empty array when server is unreachable", async () => {
    setupDiscoveryEnv();
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error("connect ECONNREFUSED 127.0.0.1:30000"),
      ) as unknown as typeof fetch;

    const models = await discoverSglangDiffusionModels("http://127.0.0.1:30000/v1");
    expect(models).toEqual([]);
  });

  it("returns empty array when server returns non-OK status", async () => {
    setupDiscoveryEnv();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    const models = await discoverSglangDiffusionModels("http://127.0.0.1:30000/v1", "bad-key");
    expect(models).toEqual([]);
  });

  it("returns empty array when no models are available", async () => {
    setupDiscoveryEnv();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    }) as unknown as typeof fetch;

    const models = await discoverSglangDiffusionModels("http://127.0.0.1:30000/v1");
    expect(models).toEqual([]);
  });

  it("skips discovery in test environments", async () => {
    // VITEST is set by default in test runs; don't clear it
    originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const models = await discoverSglangDiffusionModels("http://127.0.0.1:30000/v1");

    expect(models).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends Authorization header when apiKey is provided", async () => {
    setupDiscoveryEnv();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "test-model" }] }),
    }) as unknown as typeof fetch;

    await discoverSglangDiffusionModels("http://127.0.0.1:30000/v1", "my-secret-key");

    const [, options] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-secret-key");
  });

  it("strips trailing slashes from baseUrl", async () => {
    setupDiscoveryEnv();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "test-model" }] }),
    }) as unknown as typeof fetch;

    await discoverSglangDiffusionModels("http://127.0.0.1:30000/v1///");

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:30000/v1/models");
  });

  it("filters out entries with missing or empty IDs", async () => {
    setupDiscoveryEnv();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "valid-model" }, { id: "" }, { id: "  " }, {}, { id: "another-valid" }],
      }),
    }) as unknown as typeof fetch;

    const models = await discoverSglangDiffusionModels("http://127.0.0.1:30000/v1");
    expect(models).toEqual(["valid-model", "another-valid"]);
  });
});
