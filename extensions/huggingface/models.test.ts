import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHuggingfaceProvider,
  discoverHuggingfaceModels,
  HUGGINGFACE_MODEL_CATALOG,
  isHuggingfacePolicyLocked,
} from "./api.js";

function stubAbortSignalTimeout() {
  const controller = new AbortController();
  return vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("huggingface models", () => {
  it.each([503, 200])(
    "preserves the public advisory builder for HTTP %s with no rows",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ data: [] }, { status })),
      );
      await expect(buildHuggingfaceProvider("synthetic-key")).resolves.toMatchObject({
        models: HUGGINGFACE_MODEL_CATALOG,
      });
    },
  );

  it("limits discovered models to every available route regardless of provider order", async () => {
    const bundledModel = HUGGINGFACE_MODEL_CATALOG[0]!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "Qwen/Qwen3.8-2.4T-A95B",
              providers: [{ context_length: 1010000 }, { context_length: 262144 }],
            },
            {
              id: "test/reversed-provider-order",
              providers: [{ context_length: 262144 }, { context_length: 1010000 }],
            },
            {
              id: bundledModel.id,
              name: "Upstream name must not replace bundled metadata",
              architecture: { input_modalities: ["text", "image"] },
              providers: [
                { status: "error", context_length: 16000 },
                { context_length: 96000 },
                { context_length: 0 },
                { context_length: 64000, supports_tools: true },
              ],
            },
          ],
        }),
      ),
    );

    const models = await discoverHuggingfaceModels("hf_test_token");

    expect(models.map(({ id, contextWindow }) => ({ id, contextWindow }))).toEqual([
      { id: "Qwen/Qwen3.8-2.4T-A95B", contextWindow: 262144 },
      { id: "test/reversed-provider-order", contextWindow: 262144 },
      { id: bundledModel.id, contextWindow: 64000 },
    ]);
    expect(models[2]).toEqual({ ...bundledModel, contextWindow: 64000 });
  });

  it("disables tools whenever an available route explicitly rejects them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "test/no-tools-vision",
              architecture: { input_modalities: ["text", "image"] },
              providers: [
                { context_length: 96000, supports_tools: false },
                { context_length: 64000, supports_tools: false },
              ],
            },
            {
              id: "test/mixed-routes",
              providers: [{ supports_tools: false }, { supports_tools: true }],
            },
            {
              id: "test/reversed-mixed-routes",
              providers: [{ supports_tools: true }, { supports_tools: false }],
            },
            {
              id: "test/unknown-route",
              providers: [{ supports_tools: false }, { context_length: 48000 }],
            },
            {
              id: "test/errored-route",
              providers: [
                { status: "error", context_length: 262144, supports_tools: true },
                { status: "live", context_length: 32000, supports_tools: false },
              ],
            },
            {
              id: "test/errored-unsupported-route",
              providers: [
                { status: "error", supports_tools: false },
                { status: "live", supports_tools: true },
              ],
            },
            { id: "test/no-routes" },
            { id: "test/unknown-only", providers: [{}] },
            { id: "test/tools", providers: [{ supports_tools: true }] },
          ],
        }),
      ),
    );

    const models = await discoverHuggingfaceModels("hf_test_token");

    expect(
      models.map(({ id, input, contextWindow, compat }) => [id, input, contextWindow, compat]),
    ).toEqual([
      ["test/no-tools-vision", ["text", "image"], 64000, { supportsTools: false }],
      ["test/mixed-routes", ["text"], 131072, { supportsTools: false }],
      ["test/reversed-mixed-routes", ["text"], 131072, { supportsTools: false }],
      ["test/unknown-route", ["text"], 48000, { supportsTools: false }],
      ["test/errored-route", ["text"], 32000, { supportsTools: false }],
      ["test/errored-unsupported-route", ["text"], 131072, undefined],
      ["test/no-routes", ["text"], 131072, undefined],
      ["test/unknown-only", ["text"], 131072, undefined],
      ["test/tools", ["text"], 131072, undefined],
    ]);
  });

  it.each([
    { label: "default", timeoutMs: undefined, expected: 30_000 },
    { label: "custom", timeoutMs: 25_000, expected: 25_000 },
    { label: "oversized", timeoutMs: Number.MAX_SAFE_INTEGER, expected: MAX_TIMER_TIMEOUT_MS },
  ])("bounds the $label discovery timeout", async ({ timeoutMs, expected }) => {
    const timeoutSpy = stubAbortSignalTimeout();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } }),
      ),
    );

    await expect(
      discoverHuggingfaceModels("hf_test_token", timeoutMs, { discoveryMode: "strict" }),
    ).rejects.toMatchObject({
      status: 500,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(expected);
  });

  describe("isHuggingfacePolicyLocked", () => {
    it("returns true for :cheapest and :fastest refs", () => {
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1:cheapest")).toBe(true);
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1:fastest")).toBe(true);
    });

    it("returns false for base ref and :provider refs", () => {
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1")).toBe(false);
      expect(isHuggingfacePolicyLocked("huggingface/foo:together")).toBe(false);
    });
  });
});
