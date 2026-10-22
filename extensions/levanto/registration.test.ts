import assert from "node:assert/strict";
import {
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionQuestionV2,
  type DecisionProviderContextV2,
} from "openclaw/plugin-sdk/decisions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "Explicit synthetic evidence" },
  questions: { q: { type: "boolean", instructions: "Is this urgent?" } },
};
const reported = {
  id: "q",
  kind: "yesno",
  result: { answer: null, probability: 0.51 },
  meta: {
    model: "levanto-sage-v1.3",
    usage: { input_tokens: 12, output_tokens: 3 },
    reasoning: { ran: true, finished: false, tokens: 2, limited: "timeout", forced: true },
  },
};
const imageBatch: DecisionBatchV2 = {
  ...batch,
  state: {
    type: "image",
    dataUri:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=",
  },
};
const boxBatch: DecisionBatchV2 = {
  ...imageBatch,
  questions: { target: { type: "box", instructions: "the red square" } },
};
const nativeReply = (id: string, kind: string, result: unknown) => ({
  id,
  kind,
  result,
  meta: {},
});
const nativeAnswer = (id: string, kind: string, result: unknown) => ({
  ok: true,
  result: nativeReply(id, kind, result),
});
function fixture(response?: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  if (response) {
    fetch.mockResolvedValue(response);
  }
  vi.stubGlobal("fetch", fetch);
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  const api = createTestPluginApi({ id: "levanto", registerDecisionProvider });
  const probe = vi.fn(async () => ({ width: 1, height: 1 }));
  api.runtime.media = {
    getImageMetadata: probe,
    loadWebMedia: vi.fn(),
    detectMime: vi.fn(),
    mediaKindFromMime: vi.fn(),
    isVoiceCompatibleAudio: vi.fn(),
    resizeToJpeg: vi.fn(),
  };
  plugin.register(api);
  const provider = registerDecisionProvider.mock.calls[0]?.[0];
  assert(provider?.contractVersion === 2);
  const context: DecisionProviderContextV2 = {
    model: {
      provider: "levanto",
      id: "levanto-sage",
      name: "Sage",
      baseUrl: "https://sage.levanto.ai",
    },
    config: {},
    auth: { mode: "api-key", apiKey: "synthetic-prepared-key" },
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 500,
    isAdmissible: () => true,
  };
  return { provider, context, probe, fetch };
}
function sentRequest(fetch: ReturnType<typeof fixture>["fetch"]) {
  expect(fetch).toHaveBeenCalledOnce();
  const call = fetch.mock.calls[0];
  assert(call);
  const body = call[1]?.body;
  assert(typeof body === "string");
  return { url: call[0], body: JSON.parse(body), headers: new Headers(call[1]?.headers) };
}
function deferProbe(probe: ReturnType<typeof fixture>["probe"]) {
  const started = createDeferred<void>();
  const result = createDeferred<{ width: number; height: number }>();
  probe.mockImplementationOnce(() => {
    started.resolve();
    return result.promise;
  });
  return { started, result };
}
const questionBatch = (id: string, question: DecisionQuestionV2): DecisionBatchV2 => ({
  ...batch,
  questions: { [id]: question },
});
const unavailable = (reason: string) => ({ status: "unavailable", reason });
const unsupported = unavailable("unsupported-input");
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("registers a decision-only agent-scoped provider with standard credential setup", () => {
  const { provider, fetch } = fixture();
  expect(provider.provider).toMatchObject({
    authScope: "agent",
    envVars: ["LEVANTO_API_KEY"],
    auth: [{ id: "api-key", kind: "api_key" }],
  });
  expect(provider.provider?.resolveSyntheticAuth).toBeUndefined();
  expect(provider.provider?.auth[0]?.starterModel).toBeUndefined();
  expect(manifest.contracts).toEqual({ decisionProviders: ["levanto"] });
  const catalog = manifest.modelCatalog.providers.levanto;
  expect(catalog.authScope).toBe(provider.provider?.authScope);
  expect(catalog.models).toHaveLength(1);
  expect(catalog.models[0]).toMatchObject({
    id: "levanto-sage",
    inference: {
      chat: false,
      decision: {
        questions: {
          choice: { probabilities: "categorical", maxImageOptions: 20 },
          score: { probabilities: "categorical", minOptions: 2, maxOptions: 26 },
        },
        reasoning: { default: "off" },
        billing: { unit: "tokens" },
      },
    },
  });
  for (const key of ["api", "cost", "contextWindow", "maxTokens"]) {
    expect(catalog.models[0]).not.toHaveProperty(key);
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("accepts current native usage and reasoning without double-counting tokens or inventing cost", async () => {
  const { provider, context, fetch } = fixture(Response.json(reported));
  const outcome = await provider.evaluate(batch, { ...context, reasoning: "off" });
  assert(outcome.status === "ok");
  expect(outcome.result).toMatchObject({
    model: "levanto-sage-v1.3",
    answers: { q: { type: "boolean", answer: null, probabilityTrue: 0.51 } },
    usage: { inputTokens: 12, outputTokens: 3, raw: reported.meta.usage },
    metadata: { native: reported },
  });
  expect(validateDecisionResultV2(batch, outcome.result)).toBe(true);
  expect(outcome.result.usage).not.toHaveProperty("costUsd");
  expect(outcome.result.usage).not.toHaveProperty("units");
  const { url, body, headers } = sentRequest(fetch);
  expect(url).toBe("https://sage.levanto.ai/decide");
  expect(body).toEqual({
    content: batch.state.type === "text" ? batch.state.text : "",
    question: { id: "q", kind: "yesno", instructions: "Is this urgent?" },
    reasoning: "off",
  });
  expect(headers.get("authorization")).toBe("Bearer synthetic-prepared-key");
});
it("preserves prepared URL prefixes and private effective headers, without credential fallback", async () => {
  vi.stubEnv("LEVANTO_API_KEY", "synthetic-environment-must-not-be-used");
  const { provider, context, fetch } = fixture(Response.json(reported));
  const model = {
    ...context.model,
    baseUrl: "https://93.184.216.34/prefix",
    headers: { authorization: "Bearer synthetic-effective-header", "x-private-route": "prepared" },
  };
  await expect(
    provider.evaluate(batch, { ...context, model, auth: { mode: "api-key" } }),
  ).resolves.toEqual({ status: "unavailable", reason: "credentials-unavailable" });
  expect(fetch).not.toHaveBeenCalled();
  await provider.evaluate(batch, { ...context, model });
  expect(fetch.mock.calls[0]?.[0]).toBe("https://93.184.216.34/prefix/decide");
  expect(Object.fromEntries(new Headers(fetch.mock.calls[0]?.[1]?.headers))).toMatchObject({
    authorization: "Bearer synthetic-effective-header",
    "x-private-route": "prepared",
  });
});
it("uses one native batch for mixed scalar kinds and retains partial failures and metadata", async () => {
  const tags = [
    { id: "a", applies: null, probability: 0.51 },
    { id: "b", applies: true, probability: 0.99 },
  ];
  const input: DecisionBatchV2 = {
    state: { type: "json", value: { supplied: true } },
    questions: {
      q: { type: "boolean", criteria: { true: "Urgent", false: "Not urgent" } },
      c: { type: "choice", criteria: { a: "A", b: "B" } },
      s: { type: "score", criteria: ["zero", "one", "two", "three", "four"] },
      t: { type: "tags", criteria: { a: "A", b: "B" } },
      failed: { type: "boolean" },
    },
  };
  const native = {
    results: [
      {
        answers: [
          { ok: true, result: reported },
          nativeAnswer("c", "choice", {
            chosen: "a",
            probability: 0.7,
            probabilities: [
              { option: "a", probability: 0.7 },
              { option: "b", probability: 0.3 },
            ],
          }),
          nativeAnswer("s", "scale", {
            expectation: 2.41,
            confidence: 0.71,
            probabilities: [0.02, 0.03, 0.49, 0.44, 0.02].map((probability, level) => ({
              level,
              probability,
            })),
          }),
          nativeAnswer("t", "tags", { tags }),
          { ok: false, error: "synthetic question failure", result: null },
        ],
      },
    ],
    meta: {
      model: "levanto-sage-v1.3",
      request_count: 1,
      question_count: 5,
      usage: { input_tokens: 41, output_tokens: 5 },
      latency_ms: 30,
    },
  };
  const { provider, context, fetch } = fixture(Response.json(native));
  const outcome = await provider.evaluate(input, context);
  assert(outcome.status === "ok");
  expect(validateDecisionResultV2(input, outcome.result)).toBe(true);
  expect(outcome.result.answers).toMatchObject({
    c: { choice: "a", probability: 0.7, probabilities: { a: 0.7, b: 0.3 } },
    s: { score: 2.41, confidence: 0.71, probabilities: [0.02, 0.03, 0.49, 0.44, 0.02] },
    t: { tags },
    failed: { type: "error", code: "provider-error" },
  });
  const serialized = JSON.stringify(outcome.result.metadata);
  expect(JSON.parse(serialized)).toEqual({ native });
  expect(outcome.result.usage).toMatchObject({ inputTokens: 41, outputTokens: 5 });
  const { url, body: sent } = sentRequest(fetch);
  expect(url).toBe("https://sage.levanto.ai/decide/batch");
  expect(sent.requests).toHaveLength(1);
  expect(sent.requests[0].questions[0].instructions).toContain('"true":"Urgent"');
  expect(sent).not.toHaveProperty("reasoning");
  expect(sent).not.toHaveProperty("grounding");
  expect(sent.requests[0].questions.every((q: object) => !Object.hasOwn(q, "grounding"))).toBe(
    true,
  );
});
it.each([2, 26])("preserves a %i-level rubric and distribution", async (count) => {
  const input = questionBatch("score", {
    type: "score",
    criteria: Array.from({ length: count }, (_, i) => `Level ${i}`),
  });
  const probabilities = Array.from({ length: count }, (_, level) => ({
    level,
    probability: level === count - 1 ? 1 : 0,
  }));
  const { provider, context, fetch } = fixture(
    Response.json(
      nativeReply("score", "scale", {
        expectation: count - 1,
        confidence: 0.8,
        probabilities,
      }),
    ),
  );
  const outcome = await provider.evaluate(input, context);
  assert(outcome.status === "ok");
  expect(outcome.result.answers).toMatchObject({
    score: {
      type: "score",
      score: count - 1,
      confidence: 0.8,
      probabilities: probabilities.map((entry) => entry.probability),
    },
  });
  expect(outcome.result.usage).toBeUndefined();
  expect(sentRequest(fetch).body.question.levels).toEqual(
    Array.from({ length: count }, (_, level) => ({ level, description: `Level ${level}` })),
  );
});
it("preserves native sort without pairwise fan-out", async () => {
  const input: DecisionBatchV2 = {
    state: {
      type: "list",
      items: [
        { id: "a", content: "A" },
        { id: "b", content: { text: "B" } },
      ],
    },
    questions: { rank: { type: "sort", instructions: "Urgency" } },
  };
  const native = nativeReply("rank", "sort", { sorted: ["b", "a"], confidence: null });
  const { provider, context, fetch } = fixture(Response.json(native));
  await expect(provider.evaluate(input, context)).resolves.toMatchObject({
    status: "ok",
    result: { answers: { rank: { type: "sort", order: ["b", "a"], confidence: null } } },
  });
  expect(fetch).toHaveBeenCalledOnce();
});
it.each<DecisionBatchV2>([
  questionBatch("s", { type: "score", criteria: ["only"] }),
  questionBatch("s", { type: "score", criteria: Array.from({ length: 27 }, () => "level") }),
  questionBatch("c", {
    type: "choice",
    criteria: Object.fromEntries(Array.from({ length: 121 }, (_, i) => [String(i), null])),
  }),
  questionBatch("t", {
    type: "tags",
    criteria: Object.fromEntries(Array.from({ length: 121 }, (_, i) => [String(i), null])),
  }),
  questionBatch("s", { type: "sort" }),
  boxBatch,
])("rejects unsupported native input before an effect %#", async (input) => {
  if (input === boxBatch) {
    expect(validateDecisionBatchV2(input)).toBe(true);
  }
  const { provider, context, probe, fetch } = fixture();
  await expect(provider.evaluate(input, context)).resolves.toEqual(unsupported);
  expect(fetch).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
});
it("uses the common image probe once and rejects invalid dimensions before HTTP", async () => {
  const { provider, context, probe, fetch } = fixture(Response.json(reported));
  await expect(provider.evaluate(imageBatch, context)).resolves.toMatchObject({ status: "ok" });
  expect(probe).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
  probe.mockResolvedValue({ width: 8193, height: 1 });
  fetch.mockClear();
  await expect(provider.evaluate(imageBatch, context)).resolves.toEqual(unsupported);
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["false", "throw"])(
  "stops after image preparation when host admission returns %s",
  async (kind) => {
    const { provider, context, probe, fetch } = fixture(Response.json(reported));
    const { started, result: dimensions } = deferProbe(probe);
    let admitted = true;
    const authorityError = new Error("synthetic owner closed during image preparation");
    const pending = provider.evaluate(imageBatch, {
      ...context,
      isAdmissible: () => {
        if (!admitted && kind === "throw") {
          throw authorityError;
        }
        return admitted;
      },
    });
    const settled =
      kind === "throw"
        ? expect(pending).rejects.toBe(authorityError)
        : expect(pending).resolves.toEqual({ status: "unavailable", reason: "transport" });
    await started.promise;
    admitted = false;
    dimensions.resolve({ width: 1, height: 1 });
    await settled;
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([401, 402, 429, 503])("classifies HTTP %s without retries or leaks", async (status) => {
  const { provider, context, fetch } = fixture(
    Response.json({ detail: "synthetic-prepared-key private-evidence" }, { status }),
  );
  const outcome = await provider.evaluate(batch, context);
  expect(outcome).toMatchObject({
    status: "unavailable",
    reason: status === 401 ? "authentication" : status === 429 ? "rate-limited" : "transport",
  });
  expect(JSON.stringify(outcome)).not.toContain("private-evidence");
  expect(fetch).toHaveBeenCalledOnce();
});
it("rejects malformed native output instead of guessing an answer", async () => {
  const { provider, context } = fixture(Response.json({ ...reported, id: "wrong" }));
  await expect(provider.evaluate(batch, context)).resolves.toEqual(unavailable("invalid-response"));
});
it.each([
  ["abort", "response"],
  ["deadline", "response"],
  ["abort", "image"],
  ["deadline", "image"],
])("settles %s during %s and prevents later work", async (kind, phase) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const started = createDeferred<void>();
  const cancel = vi.fn();
  const { provider, context, probe, fetch } = fixture(
    phase === "response"
      ? new Response(
          new ReadableStream({ pull: () => started.resolve(), cancel }, { highWaterMark: 0 }),
        )
      : undefined,
  );
  const image = phase === "image" ? deferProbe(probe) : undefined;
  const controller = new AbortController();
  const pending = provider.evaluate(image ? imageBatch : batch, {
    ...context,
    signal: controller.signal,
  });
  const settled =
    kind === "abort"
      ? expect(pending).rejects.toThrow("caller closed")
      : expect(pending).resolves.toEqual(unavailable("transport"));
  await (image?.started ?? started).promise;
  if (kind === "abort") {
    controller.abort(new Error("caller closed"));
  } else {
    await vi.advanceTimersByTimeAsync(501);
  }
  await settled;
  expect(vi.getTimerCount()).toBe(0);
  if (image) {
    expect(fetch).not.toHaveBeenCalled();
    image.result.resolve({ width: 1, height: 1 });
    await image.result.promise;
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  } else {
    expect(cancel).toHaveBeenCalled();
  }
});

it.each([
  ["levanto", "header"],
  ["Levanto", "header"],
  ["levanto", "provider-default"],
] as const)("consumes prepared %s credentials with %s policy", async (providerId, mode) => {
  const { provider, context, fetch } = fixture(Response.json(reported));
  const custom = mode === "header";
  const headers = {
    "X-Prepared-Auth": "synthetic-resolved-auth",
    "X-Managed": "synthetic-resolved-header",
  };
  const secret = (id: string) => ({ source: "env", provider: "default", id }) as const;
  const configured = {
    baseUrl: "https://sage.levanto.ai",
    models: [],
    headers: custom ? { "X-Managed": secret("SAGE_HEADER_FIXTURE") } : undefined,
    request: custom
      ? {
          headers: { "X-Managed": "must-not-replay" },
          auth: {
            mode: "header" as const,
            headerName: "X-Prepared-Auth",
            value: secret("SAGE_AUTH_FIXTURE"),
          },
        }
      : { auth: { mode: "provider-default" as const } },
  };
  const outcome = await provider.evaluate(batch, {
    ...context,
    model: { ...context.model, headers: custom ? headers : undefined },
    config: { models: { providers: { [providerId]: configured } } },
  });
  expect(outcome.status).toBe("ok");
  expect(fetch).toHaveBeenCalledOnce();
  const sentHeaders = new Headers(fetch.mock.calls[0]?.[1]?.headers);
  if (custom) {
    expect(Object.fromEntries(sentHeaders)).toMatchObject({
      "x-prepared-auth": "synthetic-resolved-auth",
      "x-managed": "synthetic-resolved-header",
    });
    expect(sentHeaders.has("authorization")).toBe(false);
  } else {
    expect(sentHeaders.get("authorization")).toBe("Bearer synthetic-prepared-key");
  }
});
