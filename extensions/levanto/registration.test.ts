import assert from "node:assert/strict";
import {
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionQuestionV2,
  type DecisionProviderContextV2,
} from "openclaw/plugin-sdk/decisions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { registerLevantoTestProvider } from "./registration.test-support.js";

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
function fixture(response?: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  if (response !== undefined) {
    fetch.mockResolvedValue(Response.json(response));
  }
  vi.stubGlobal("fetch", fetch);
  const probe = vi.fn(async () => ({ width: 1, height: 1 }));
  const provider = registerLevantoTestProvider(probe);
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
  return { url: call[0], body: JSON.parse(body) };
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
beforeEach(() => {
  // The fixture owns a finite caller budget, not a cold request-policy benchmark.
  // Only deadline scenarios advance time; HTTP, credentials and parsing stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});
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
it("does not fall back to effective headers or environment credentials", async () => {
  vi.stubEnv("LEVANTO_API_KEY", "synthetic-environment-must-not-be-used");
  const { provider, context, fetch } = fixture(reported);
  await expect(
    provider.evaluate(batch, {
      ...context,
      model: { ...context.model, headers: { authorization: "Bearer synthetic-effective-header" } },
      auth: { mode: "api-key" },
    }),
  ).resolves.toEqual({ status: "unavailable", reason: "credentials-unavailable" });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([2, 5, 26])(
  "batches mixed scalar kinds with a %i-level rubric and retains partial failures",
  async (count) => {
    const criteria = Array.from({ length: count }, (_, i) => `Level ${i}`);
    const score = count === 5 ? 2.41 : count - 1;
    const probabilities =
      count === 5
        ? [0.02, 0.03, 0.49, 0.44, 0.02]
        : Array.from({ length: count }, (_, i) => (i === count - 1 ? 1 : 0));
    const tags = [
      { id: "a", applies: null, probability: 0.51 },
      { id: "b", applies: true, probability: 0.99 },
    ];
    const input: DecisionBatchV2 = {
      state: { type: "json", value: { supplied: true } },
      questions: {
        q: { type: "boolean", criteria: { true: "Urgent", false: "Not urgent" } },
        c: { type: "choice", criteria: { a: "A", b: "B" } },
        s: { type: "score", criteria },
        t: { type: "tags", criteria: { a: "A", b: "B" } },
        failed: { type: "boolean" },
      },
    };
    const answers = [
      { ok: true, result: reported },
      nativeAnswer("c", "choice", {
        chosen: "a",
        probability: 0.7,
        probabilities: [0.7, 0.3].map((probability, i) => ({ option: ["a", "b"][i], probability })),
      }),
      nativeAnswer("s", "scale", {
        expectation: score,
        confidence: 0.71,
        probabilities: probabilities.map((probability, level) => ({ level, probability })),
      }),
      nativeAnswer("t", "tags", { tags }),
      { ok: false, error: "synthetic question failure", result: null },
    ];
    const native = {
      results: [{ answers }],
      meta: {
        model: "levanto-sage-v1.3",
        request_count: 1,
        question_count: 5,
        usage: { input_tokens: 41, output_tokens: 5 },
      },
    };
    const { provider, context, fetch } = fixture(native);
    const outcome = await provider.evaluate(input, context);
    assert(outcome.status === "ok", JSON.stringify(outcome));
    expect(validateDecisionResultV2(input, outcome.result)).toBe(true);
    expect(outcome.result.answers).toMatchObject({
      q: { type: "boolean", answer: null, probabilityTrue: 0.51, metadata: { native: reported } },
      c: { choice: "a", probability: 0.7, probabilities: { a: 0.7, b: 0.3 } },
      s: { type: "score", score, confidence: 0.71, probabilities },
      t: { tags },
      failed: { type: "error", code: "provider-error" },
    });
    const serialized = JSON.stringify(outcome.result.metadata);
    expect(JSON.parse(serialized)).toEqual({ native });
    expect(outcome.result.model).toBe("levanto-sage-v1.3");
    expect(outcome.result.usage).toEqual({
      inputTokens: 41,
      outputTokens: 5,
      raw: native.meta.usage,
    });
    const { url, body: sent } = sentRequest(fetch);
    expect(url).toBe("https://sage.levanto.ai/decide/batch");
    expect(sent.requests).toHaveLength(1);
    expect(sent.requests[0].questions[0].instructions).toContain('"true":"Urgent"');
    expect(sent.requests[0].questions[2].levels).toEqual(
      criteria.map((description, level) => ({ level, description })),
    );
    expect(sent).not.toHaveProperty("reasoning");
    expect(sent).not.toHaveProperty("grounding");
    expect(sent.requests[0].questions.every((q: object) => !Object.hasOwn(q, "grounding"))).toBe(
      true,
    );
  },
);
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
  const { provider, context, fetch } = fixture(native);
  const outcome = await provider.evaluate(input, context);
  assert(outcome.status === "ok");
  expect(outcome.result.answers).toMatchObject({
    rank: { type: "sort", order: ["b", "a"], confidence: null },
  });
  expect(outcome.result.usage).toBeUndefined();
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
  const { provider, context, probe, fetch } = fixture(reported);
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
    const { provider, context, probe, fetch } = fixture(reported);
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
it.each(["abort", "deadline"])(
  "settles %s during image preparation and prevents later work",
  async (kind) => {
    const { provider, context, probe, fetch } = fixture();
    const image = deferProbe(probe);
    const controller = new AbortController();
    const pending = provider.evaluate(imageBatch, {
      ...context,
      signal: controller.signal,
    });
    const settled =
      kind === "abort"
        ? expect(pending).rejects.toThrow("caller closed")
        : expect(pending).resolves.toEqual(unavailable("transport"));
    await image.started.promise;
    if (kind === "abort") {
      controller.abort(new Error("caller closed"));
    } else {
      await vi.advanceTimersByTimeAsync(501);
    }
    await settled;
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    image.result.resolve({ width: 1, height: 1 });
    await image.result.promise;
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([
  ["levanto", "header"],
  ["Levanto", "header"],
  ["levanto", "provider-default"],
] as const)("consumes prepared %s credentials with %s policy", async (providerId, mode) => {
  const { provider, context, fetch } = fixture(reported);
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
