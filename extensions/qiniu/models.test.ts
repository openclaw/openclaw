import { describe, expect, it, vi } from "vitest";
import { discoverQiniuModels, QINIU_MODELS_URL } from "./models.js";

function withFetchPathTest(
  mockFetch: ReturnType<typeof vi.fn>,
  runAssertions: () => Promise<void>,
): Promise<void> {
  const origNodeEnv = process.env.NODE_ENV;
  const origVitest = process.env.VITEST;
  delete process.env.NODE_ENV;
  delete process.env.VITEST;

  vi.stubGlobal("fetch", mockFetch);

  return runAssertions().finally(() => {
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
  });
}

describe("discoverQiniuModels", () => {
  it("returns static catalog in test environment", async () => {
    const models = await discoverQiniuModels();
    expect(models.some((model) => model.id === "deepseek-v3")).toBe(true);
  });
});

describe("discoverQiniuModels (fetch path)", () => {
  it("discovers models using bearer auth and keeps fallback model", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: "qwen-plus" }, { id: "deepseek-v3" }],
        }),
    });

    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverQiniuModels("qiniu-key");
      expect(mockFetch).toHaveBeenCalledWith(
        QINIU_MODELS_URL,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer qiniu-key",
          }),
        }),
      );
      expect(models.some((model) => model.id === "qwen-plus")).toBe(true);
      expect(models.some((model) => model.id === "deepseek-v3")).toBe(true);
    });
  });

  it("falls back to deepseek-v3 on HTTP failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverQiniuModels("qiniu-key");
      expect(models.map((model) => model.id)).toEqual(["deepseek-v3"]);
    });
  });
});
