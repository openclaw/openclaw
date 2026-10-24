import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { resolveProviderHttpRequestConfigWithOriginTrust } from "openclaw/plugin-sdk/provider-http";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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

const { batch, input, response, localInput, localResponse, result: expectedResult } = mixedFixture;

function registeredProvider(config: Record<string, unknown> = {}) {
  return registeredDecisionProvider(() => ({ plugins: { entries: { typesafe: { config } } } }));
}

const context = (
  signal = new AbortController().signal,
  deadlineMonotonicMs = performance.now() + 1000,
) => ({
  model: "jev-agent-selected",
  agentId: "research",
  signal,
  deadlineMonotonicMs,
});
const withAnswer = (id: keyof typeof response.answers, overrides: object) => ({
  answers: { ...response.answers, [id]: { ...response.answers[id], ...overrides } },
});
const clientConfig = { apiKey: "synthetic-key", timeoutMs: 1000 };
const localConfig = { ...clientConfig, baseUrl: "http://127.0.0.1:8009" };
const request = (config = clientConfig, signal?: AbortSignal) => evaluate(input, config, signal);
it("never follows redirects to a credential sink", async () => {
  const fetch = mockBodyResponse(null, {
    status: 302,
    headers: { location: "https://other.example/credential-sink" },
  });
  await expect(request()).rejects.toMatchObject({ reason: "transport" });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
});
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
  await expect(request(clientConfig, controller.signal)).rejects.toThrow(
    "TypeSafe evaluation cancelled.",
  );
});
it("preserves bounded multi-chunk JSON responses", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      const json = JSON.stringify(response);
      for (const chunk of [json.slice(0, 50), json.slice(50)]) {
        stream.enqueue(new TextEncoder().encode(chunk));
      }
      stream.close();
    },
  });
  mockBodyResponse(body);
  await expect(request()).resolves.toEqual({ evaluation: response });
});
it.each<[number, string, HeadersInit, number?]>([
  [400, "unsupported-input", {}],
  [401, "authentication", {}],
  [403, "authentication", {}],
  [413, "unsupported-input", {}],
  [422, "unsupported-input", {}],
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
    const error = await request().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "EvaluationError", reason, retryAfterMs });
    if (reason === "unsupported-input") {
      expect(error).toHaveProperty("message", "TypeSafe rejected the supplied input.");
    }
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("synthetic credential");
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
  let settled = false;
  const outcome = request(clientConfig, controller.signal)
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await setImmediate();
    if (trigger === "abort") {
      controller.abort("synthetic-private-abort");
    }
    await setImmediate();
    expect(release).toHaveBeenCalledOnce();
    expect(nativeCancel).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    cancellationGate.resolve();
    await setImmediate();
    expect(settled).toBe(false);
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

it("binds credentials to the provider API origin", async () => {
  const fetch = mockBodyResponse(JSON.stringify(localResponse));
  await evaluate(input, {
    ...clientConfig,
    baseUrl: "https://unrelated.example",
    providerConfig: { baseUrl: "https://decision.example.com/v1", models: [] },
  });
  expect(fetch.mock.calls[0]?.[0]).toBe("https://decision.example.com/v1/systemone");
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
    "Bearer synthetic-key",
  );
});

beforeAll(async () => {
  // Response-contract assertions start after loader/policy setup; cold-import
  // deadline admission is covered separately by registration.lazy.test.ts.
  await import("./client.js");
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

const metadata = {
  metrics: { seconds: 0.05 },
  scoring: { calibrated: false },
  latency_ms: 15.7,
};
const usageMetadata = {
  output_tokens_basis: "scored_decision_positions",
  decision_positions: 3,
};
const withMetadata = { ...response, ...metadata, usage: { ...response.usage, ...usageMetadata } };
const tokens = (output_tokens: unknown) => ({ usage: { input_tokens: 12, output_tokens } });

it.each<{ mode: string; config: { baseUrl?: string } }>([
  { mode: "hosted", config: {} },
  { mode: "local", config: { baseUrl: "http://127.0.0.1:8009" } },
])("preserves $mode mixed answers and additive metadata", async ({ config }) => {
  vi.stubEnv("TYPESAFE_BASE_URL", "https://invalid.example");
  vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "unexpected");
  const fetch = mockResponse({
    ...withMetadata,
    answers: config.baseUrl ? localResponse.answers : response.answers,
  });
  const provider = registeredProvider(config);
  await expect(provider.evaluate(batch, context())).resolves.toEqual(expectedResult);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe(
    config.baseUrl ? `${config.baseUrl}/v1/systemone` : "https://api.typesafe.ai/v1/systemone",
  );
  expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
    config.baseUrl ? null : "Bearer synthetic-key",
  );
  const body = fetch.mock.calls[0]?.[1]?.body;
  assert(typeof body === "string");
  expect(JSON.parse(body)).toEqual({
    ...(config.baseUrl ? localInput : input),
    model: "jev-agent-selected",
  });
});
it.each([
  ["missing model", { model: undefined }],
  ["malformed model", { model: 42 }],
  ["missing answers", { answers: undefined }],
  ["missing usage", { usage: undefined }],
  ["missing token count", { usage: { input_tokens: 12 } }],
  ["malformed token count", { usage: { input_tokens: "12", output_tokens: 3 } }],
  ["negative token count", tokens(-1)],
  ["fractional token count", tokens(1.5)],
  ["unsafe token count", tokens(Number.MAX_SAFE_INTEGER + 1)],
  ["missing answer", { answers: { c: response.answers.c, s: response.answers.s } }],
  ["extra answer", { answers: { ...response.answers, extra: response.answers.q } }],
  ["mismatched answer type", { answers: { ...response.answers, q: response.answers.c } }],
  ["extra answer field", withAnswer("q", { debug: true })],
  ["invalid distribution probability", withAnswer("c", { probabilities: { keep: -0.1, skip: 1 } })],
  ["malformed confidence", withAnswer("c", { confidence: "0.5" })],
  ["out of range boolean", withAnswer("q", { noul: 1.01 })],
  ["unknown probability label", withAnswer("c", { probabilities: { keep: 0.5, other: 0.5 } })],
  ["excessive metadata bytes", { metrics: "x".repeat(4 * 1024 * 1024) }],
  ["excessive metadata nodes", { metrics: Array(262144).fill(null) }],
  [
    "excessive metadata depth",
    { metrics: Array.from({ length: 65 }).reduce<unknown>((value) => [value], null) },
  ],
  [
    "nonfinite required number",
    JSON.stringify(withMetadata).replace('"noul":0.37', '"noul":1e400'),
  ],
])("rejects %s despite additive metadata", async (_name, invalid) => {
  mockResponse(typeof invalid === "string" ? invalid : { ...withMetadata, ...invalid });
  await expect(registeredProvider().evaluate(batch, context())).resolves.toEqual({
    status: "unavailable",
    reason: "invalid-response",
  });
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

it("requires prepared credentials, not ambient or unresolved keys", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "unused-synthetic-key");
  const fetch = mockResponse({});
  await expect(
    evaluate(
      input,
      runtimeConfig({ apiKey: { source: "env", provider: "default", id: "TYPESAFE_API_KEY" } }),
    ),
  ).rejects.toThrow("API key is missing");
  expect(fetch).not.toHaveBeenCalled();
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
  await expect(request(clientConfig, controller.signal)).rejects.toThrow(
    "TypeSafe evaluation cancelled.",
  );
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

it("preserves HTTP retry hints through the registered adapter", async () => {
  const fetch = mockResponse("synthetic-key: synthetic only", {
    status: 429,
    headers: { "retry-after-ms": "123" },
  });
  expect(await registeredProvider().evaluate(batch, context())).toEqual({
    status: "unavailable",
    reason: "rate-limited",
    retryAfterMs: 123,
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it("observes credential rotation, loss, recovery and cancellation", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "synthetic-ambient");
  const fetch = mockResponse(response);
  const provider = registeredProvider({ apiKey: "synthetic-unprepared" });
  const controller = new AbortController();
  for (const [revision, key] of [
    "synthetic-key",
    "synthetic-rotated",
    undefined,
    "synthetic-recovered",
  ].entries()) {
    vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision, value: key });
    expect(provider.isReady?.()).toBe(Boolean(key));
    fetch.mockClear();
    const outcome = await provider.evaluate(batch, context(controller.signal));
    if (key) {
      expect(outcome.status).toBe("ok");
      expect(new Headers(fetch.mock.lastCall?.[1]?.headers).get("authorization")).toBe(
        `Bearer ${key}`,
      );
      expect(JSON.stringify(outcome)).not.toContain(key);
      expect(fetch).toHaveBeenCalledOnce();
    } else {
      expect(outcome).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
      expect(fetch).not.toHaveBeenCalled();
    }
  }
  fetch.mockClear();
  controller.abort(new Error("caller closed"));
  await expect(provider.evaluate(batch, context(controller.signal))).rejects.toThrow(
    "caller closed",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it.each<DecisionBatch>([
  { state: null, questions: { s: { type: "score", criteria: Array(11).fill("level") } } },
  {
    state: null,
    questions: {
      c: {
        type: "choice",
        criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), null])),
      },
    },
  },
  { ...batch, state: { constructor: "synthetic reserved key" } },
])("rejects unsupported vendor input without dispatch", async (value) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(registeredProvider().evaluate(value, context())).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects dispatch after preparation exhausts the deadline", async () => {
  const fetch = mockResponse(response);
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(100);
  await expect(registeredProvider().evaluate(batch, context(undefined, 50))).resolves.toEqual({
    status: "unavailable",
    reason: "transport",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("uses only the deadline remaining after preparation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(40);
  const started = Promise.withResolvers<AbortSignal>();
  mockFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert(signal);
        signal.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
        started.resolve(signal);
      }),
  );
  const controller = new AbortController();
  const pending = registeredProvider().evaluate(batch, context(controller.signal, 50));
  try {
    const signal = await started.promise;
    await vi.advanceTimersByTimeAsync(9);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ status: "unavailable", reason: "transport" });
  } finally {
    controller.abort();
    await pending.catch(() => {});
    vi.useRealTimers();
  }
});
