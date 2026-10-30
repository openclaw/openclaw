import assert from "node:assert/strict";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildHuggingfaceProvider,
  discoverHuggingfaceModels,
  HUGGINGFACE_MODEL_CATALOG,
} from "./api.js";

function stubModels(data: unknown[], status = 200) {
  const fetchModels = vi.fn(async () => Response.json({ data }, { status }));
  vi.stubGlobal("fetch", fetchModels);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([503, 200])("keeps the advisory catalog for HTTP %s with no rows", async (status) => {
  stubModels([], status);
  await expect(buildHuggingfaceProvider("synthetic-key")).resolves.toMatchObject({
    models: HUGGINGFACE_MODEL_CATALOG,
  });
});

it("limits discovered models to every available route regardless of provider order", async () => {
  const bundledModel = HUGGINGFACE_MODEL_CATALOG[0]!;
  stubModels([
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
  ]);
  const models = await discoverHuggingfaceModels("hf_test_token");
  expect(models.map(({ id, contextWindow }) => ({ id, contextWindow }))).toEqual([
    { id: "Qwen/Qwen3.8-2.4T-A95B", contextWindow: 262144 },
    { id: "test/reversed-provider-order", contextWindow: 262144 },
    { id: bundledModel.id, contextWindow: 64000 },
  ]);
  expect(models[2]).toEqual({ ...bundledModel, contextWindow: 64000 });
});

it("disables tools whenever an available route explicitly rejects them", async () => {
  stubModels([
    {
      id: "test/no-tools-vision",
      architecture: { input_modalities: ["text", "image"] },
      providers: [
        { context_length: 96000, supports_tools: false },
        { context_length: 64000, supports_tools: false },
      ],
    },
    ...Object.entries({
      "mixed-routes": [{ supports_tools: false }, { supports_tools: true }],
      "reversed-mixed-routes": [{ supports_tools: true }, { supports_tools: false }],
      "unknown-route": [{ supports_tools: false }, { context_length: 48000 }],
      "errored-route": [
        { status: "error", context_length: 262144, supports_tools: true },
        { status: "live", context_length: 32000, supports_tools: false },
      ],
      "errored-unsupported-route": [
        { status: "error", supports_tools: false },
        { status: "live", supports_tools: true },
      ],
      "unknown-only": [{}],
      tools: [{ supports_tools: true }],
    }).map(([id, providers]) => ({ id: `test/${id}`, providers })),
    { id: "test/no-routes" },
  ]);
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
    ["test/unknown-only", ["text"], 131072, undefined],
    ["test/tools", ["text"], 131072, undefined],
    ["test/no-routes", ["text"], 131072, undefined],
  ]);
});

it.each([
  { label: "default", timeoutMs: undefined, expected: 30_000 },
  { label: "custom", timeoutMs: 25_000, expected: 25_000 },
  { label: "oversized", timeoutMs: Number.MAX_SAFE_INTEGER, expected: MAX_TIMER_TIMEOUT_MS },
])("bounds the $label discovery timeout", async ({ timeoutMs, expected }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockReturnValue(0);
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, init?: RequestInit) => {
      const signal = init?.signal;
      assert(signal, "Discovery transport requires cancellation");
      signal.addEventListener(
        "abort",
        () => {
          const reason: unknown = signal.reason;
          assert(reason instanceof Error);
          response.reject(reason);
        },
        { once: true },
      );
      started.resolve();
      return response.promise;
    }),
  );

  const outcome = expect(
    discoverHuggingfaceModels("hf_test_token", timeoutMs, { discoveryMode: "strict" }),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  await started.promise;
  await vi.advanceTimersByTimeAsync(expected - 1);
  expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await outcome;
});
