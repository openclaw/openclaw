import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { resolveProviderHttpRequestConfigWithOriginTrust } from "openclaw/plugin-sdk/provider-http";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { hangingFetchUntilAbort } from "../../test-support/hanging-fetch.test-support.js";
import { evaluate } from "./client.js";
import { runtimeConfig } from "./config.js";
import { MAX_JSON_BYTES } from "./schema.js";
import {
  mixedFixture,
  mockFetch,
  mockResponse as mockBodyResponse,
  mockJsonResponse as mockResponse,
  registeredDecisionProvider,
} from "./transport.test-support.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));
const { batch, input, response, result: expectedResult } = mixedFixture;
function registeredProvider(config: Record<string, unknown> = {}) {
  return registeredDecisionProvider(() => ({ plugins: { entries: { typesafe: { config } } } }));
}
const context = (
  signal = new AbortController().signal,
  deadlineMonotonicMs = performance.now() + 1000,
) => ({
  model: "jev-agent-selected",
  signal,
  deadlineMonotonicMs,
});
const withAnswer = (id: keyof typeof response.answers, overrides: object) => ({
  answers: { ...response.answers, [id]: { ...response.answers[id], ...overrides } },
});
const clientConfig = { apiKey: "synthetic-key", timeoutMs: 1000 };
const localConfig = { ...clientConfig, baseUrl: "http://127.0.0.1:8009" };
const request = (config = clientConfig, signal?: AbortSignal) => evaluate(input, config, signal);
const expectCancelled = (pending: ReturnType<typeof request>) =>
  expect(pending).rejects.toThrow("TypeSafe evaluation cancelled.");
const expectUnavailable = (
  pending: ReturnType<ReturnType<typeof registeredProvider>["evaluate"]>,
  reason: string,
) => expect(pending).resolves.toEqual({ status: "unavailable", reason });
function expectAuthorization(fetch: ReturnType<typeof mockFetch>, value: string | null) {
  expect(new Headers(fetch.mock.lastCall?.[1]?.headers).get("authorization")).toBe(value);
}
it("bounds expanded local request bytes", async () => {
  const fetch = mockBodyResponse(undefined);
  const emptyBody = { ...input, state: "" };
  const state = "x".repeat(MAX_JSON_BYTES - Buffer.byteLength(JSON.stringify(emptyBody)));
  await expect(evaluate({ ...emptyBody, state }, localConfig)).rejects.toThrow("request exceeds");
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps the deadline active after response headers", async () => {
  const cancelled = vi.fn();
  mockBodyResponse(new ReadableStream({ pull() {}, cancel: cancelled }));
  await expect(request({ ...clientConfig, timeoutMs: 25 })).rejects.toThrow(
    "TypeSafe evaluation timed out.",
  );
  expect(cancelled).toHaveBeenCalledOnce();
});
it("rejects cancellation concurrent with body EOF", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        controller.abort("synthetic-private-reason");
        stream.close();
      },
    },
    { highWaterMark: 0 },
  );
  mockBodyResponse(body);
  await expectCancelled(request(clientConfig, controller.signal));
});
it.each<[number, string, HeadersInit, number?]>([
  [400, "unsupported-input", {}],
  [401, "authentication", {}],
  [500, "transport", {}],
  [429, "rate-limited", { "retry-after-ms": "250", "retry-after": "10" }, 250],
  [429, "rate-limited", { "retry-after-ms": "invalid", "retry-after": "10" }, 10000],
  [429, "rate-limited", { "retry-after": "invalid" }],
])(
  "classifies HTTP %s without reading or retrying",
  async (status, reason, headers, retryAfterMs) => {
    const pull = vi.fn(() => {
      throw new Error("synthetic credential and submitted state");
    });
    const cancel = vi.fn();
    const fetch = mockBodyResponse(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      status,
      headers: new Headers(headers),
    });
    const error = await registeredProvider().evaluate(batch, context());
    expect(error).toEqual({ status: "unavailable", reason, retryAfterMs });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each([
  { status: 401, trigger: "http", reason: "authentication" },
  { status: 200, trigger: "abort", reason: "transport" },
  { status: 200, trigger: "abort-at-headers", reason: "transport" },
  { status: 200, trigger: "overflow", reason: "invalid-response" },
])("joins cancellation and release for $trigger/$status", async ({ status, trigger, reason }) => {
  const cancellationGate = Promise.withResolvers<void>();
  const releaseGate = Promise.withResolvers<void>();
  const nativeCancel = vi.fn(() => cancellationGate.promise);
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (trigger === "overflow") {
          controller.enqueue(new Uint8Array(MAX_JSON_BYTES + 1));
        }
      },
      cancel: nativeCancel,
    },
    { highWaterMark: 0 },
  );
  const [consumer, capture] = stream.tee();
  const release = vi.fn(async () => {
    await capture.cancel();
    await releaseGate.promise;
  });
  const controller = new AbortController();
  vi.spyOn(providerHttp, "fetchWithProviderHttpGuard").mockImplementationOnce(async () => {
    if (trigger === "abort-at-headers") {
      controller.abort("synthetic-private-abort");
    }
    return {
      response: new Response(consumer, { status, headers: { "content-length": "1" } }),
      finalUrl: "https://api.typesafe.ai/v1/systemone",
      release,
      refreshTimeout: () => {},
    };
  });
  const settled = vi.fn();
  const outcome = request(clientConfig, controller.signal)
    .catch((error: unknown) => error)
    .finally(settled);
  try {
    await setImmediate();
    if (trigger === "abort") {
      controller.abort("synthetic-private-abort");
    }
    await setImmediate();
    expect(release).toHaveBeenCalledOnce();
    expect(nativeCancel).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    cancellationGate.resolve();
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();
    releaseGate.resolve();
    expect(await outcome).toMatchObject({ name: "EvaluationError", reason });
    if (trigger === "overflow") {
      expect(await outcome).toHaveProperty("message", "TypeSafe response exceeds its limit.");
    } else if (trigger.startsWith("abort")) {
      expect(await outcome).toHaveProperty("message", "TypeSafe evaluation cancelled.");
    }
    expect(release).toHaveBeenCalledOnce();
  } finally {
    // Also release the fixture after an assertion fails against the old sequential implementation.
    const cancellation = Promise.allSettled([consumer.cancel(), capture.cancel()]);
    cancellationGate.resolve();
    releaseGate.resolve();
    await cancellation;
    await outcome;
  }
});
// The static client import is warm; cold-import admission lives in registration.lazy.test.ts.
beforeAll(() => {
  resolveProviderHttpRequestConfigWithOriginTrust({
    provider: "typesafe",
    baseUrl: "https://api.typesafe.ai/v1",
    defaultBaseUrl: "https://api.typesafe.ai/v1",
  });
});
beforeEach(() => {
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: "synthetic-key" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const withMetadata = {
  ...response,
  metrics: { seconds: 0.05, description: "Bearer demo" },
  usage: { ...response.usage, decision_positions: 3 },
};
const tokens = (output_tokens: unknown) => ({ usage: { input_tokens: 12, output_tokens } });
it("preserves hosted mixed answers and additive metadata", async () => {
  vi.stubEnv("TYPESAFE_BASE_URL", "https://invalid.example");
  vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "unexpected");
  const fetch = mockResponse(withMetadata);
  await expect(registeredProvider().evaluate(batch, context())).resolves.toEqual(expectedResult);
  expect(fetch).toHaveBeenCalledOnce();
  expectAuthorization(fetch, "Bearer synthetic-key");
});
it.each([
  { model: undefined },
  { model: 42 },
  { answers: undefined },
  { usage: undefined },
  { usage: { input_tokens: 12 } },
  { usage: { input_tokens: "12", output_tokens: 3 } },
  tokens(-1),
  tokens(1.5),
  tokens(Number.MAX_SAFE_INTEGER + 1),
  { answers: { c: response.answers.c, s: response.answers.s } },
  { answers: { ...response.answers, q: response.answers.c } },
  withAnswer("q", { debug: true }),
  withAnswer("c", { probabilities: { keep: -0.1, skip: 1 } }),
  withAnswer("c", { confidence: "0.5" }),
  withAnswer("q", { noul: 1.01 }),
  withAnswer("c", { probabilities: { keep: 0.5, other: 0.5 } }),
  { metrics: Array(262144).fill(null) },
  { metrics: Array.from({ length: 65 }).reduce<unknown>((value) => [value], null) },
])("rejects invalid response %# despite additive metadata", async (invalid) => {
  mockResponse({ ...withMetadata, ...invalid });
  await expectUnavailable(registeredProvider().evaluate(batch, context()), "invalid-response");
});
it.each([
  ["transport", "transport", "TypeSafe transport unavailable"],
  ["invalid JSON", "invalid-response", "TypeSafe returned invalid JSON"],
  ["reflected credential", "invalid-response", "TypeSafe evaluation failed"],
])("sanitizes %s errors", async (kind, reason, message) => {
  mockFetch(async () => {
    if (kind === "transport") {
      throw new Error(clientConfig.apiKey);
    }
    return new Response(
      kind === "invalid JSON"
        ? "not json"
        : JSON.stringify({ ...response, model: clientConfig.apiKey }),
    );
  });
  const outcome = request();
  await expect(outcome).rejects.toMatchObject({ reason });
  await expect(outcome).rejects.toThrow(message);
});
it.each(["before dispatch", "in flight"])("sanitizes cancellation %s", async (phase) => {
  const controller = new AbortController();
  const fetch = mockFetch(async (_url, init) => {
    controller.abort(clientConfig.apiKey);
    init?.signal?.throwIfAborted();
    return new Response(JSON.stringify(response));
  });
  if (phase === "before dispatch") {
    controller.abort(clientConfig.apiKey);
  }
  await expectCancelled(request(clientConfig, controller.signal));
  expect(fetch).toHaveBeenCalledTimes(phase === "before dispatch" ? 0 : 1);
});
const cyclic: unknown[] = [];
cyclic.push(cyclic);
const privateQuestion = (question: object) => ({
  ...input,
  state: "private state",
  questions: { "private ID": question },
});
it.each([
  { ...input, questions: {} },
  { ...input, state: cyclic },
  { ...input, state: "😀".repeat(MAX_JSON_BYTES / 4 + 1) },
  { ...input, state: Array(262145) },
  { ...input, state: { bad: Infinity } },
  { ...input, questions: { bad: { type: "score", criteria: ["only"] } } },
  privateQuestion({ type: "noul", instructions: 42 }),
  privateQuestion({ type: "noul", criteria: { true: false } }),
  privateQuestion({ type: "choice", criteria: { a: { nested: undefined }, b: "B" } }),
])("rejects private invalid input before dispatch", async (value) => {
  const fetch = mockResponse({});
  const error = await evaluate(value, clientConfig).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ name: "EvaluationError", reason: "unsupported-input" });
  expect(String(error)).not.toMatch(/private state|private ID/);
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects ambient and unprepared hosted credentials before dispatch", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "synthetic-ambient");
  const fetch = mockResponse(response);
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1 });
  await expectUnavailable(
    registeredProvider({ apiKey: "synthetic-unprepared" }).evaluate(batch, context()),
    "credentials-unavailable",
  );
  await expect(
    evaluate(
      input,
      runtimeConfig({ apiKey: { source: "env", provider: "default", id: "TYPESAFE_API_KEY" } }),
    ),
  ).rejects.toThrow("API key is missing");
  expect(fetch).not.toHaveBeenCalled();
});
const oversizedChoices = Object.fromEntries(
  Array.from({ length: 256 }, (_, i) => [String(i), null]),
);
it.each<DecisionBatch>([
  { state: null, questions: { s: { type: "score", criteria: Array(11).fill("level") } } },
  { state: null, questions: { c: { type: "choice", criteria: oversizedChoices } } },
  { ...batch, state: { constructor: "synthetic reserved key" } },
])("rejects unsupported vendor input without dispatch", async (value) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expectUnavailable(registeredProvider().evaluate(value, context()), "unsupported-input");
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects dispatch after preparation exhausts the deadline", async () => {
  const fetch = mockResponse(response);
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(100);
  await expectUnavailable(
    registeredProvider().evaluate(batch, context(undefined, 50)),
    "transport",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("uses only the deadline remaining after preparation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(40);
  const started = Promise.withResolvers<AbortSignal>();
  mockFetch((url, init) => {
    assert(init?.signal);
    started.resolve(init.signal);
    return hangingFetchUntilAbort(url, init);
  });
  const controller = new AbortController();
  const pending = registeredProvider().evaluate(batch, context(controller.signal, 50));
  try {
    const signal = await started.promise;
    await vi.advanceTimersByTimeAsync(9);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await expectUnavailable(pending, "transport");
  } finally {
    controller.abort();
    await pending.catch(() => {});
    vi.useRealTimers();
  }
});
