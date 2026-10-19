import assert from "node:assert/strict";
import {
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchV2,
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
function fixture() {
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
  return { provider, context, probe };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("registers a decision-only agent-scoped provider with standard credential setup", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { provider } = fixture();
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
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(reported));
  vi.stubGlobal("fetch", fetch);
  const { provider, context } = fixture();
  const outcome = await provider.evaluate(batch, { ...context, reasoning: "off" });
  expect(outcome).toMatchObject({
    status: "ok",
    result: {
      model: "levanto-sage-v1.3",
      answers: { q: { type: "boolean", answer: null, probabilityTrue: 0.51 } },
      usage: { inputTokens: 12, outputTokens: 3, raw: reported.meta.usage },
      metadata: { native: reported },
    },
  });
  assert(outcome.status === "ok");
  expect(validateDecisionResultV2(batch, outcome.result)).toBe(true);
  expect(outcome.result.usage).not.toHaveProperty("costUsd");
  expect(outcome.result.usage).not.toHaveProperty("units");
  expect(fetch).toHaveBeenCalledOnce();
  const call = fetch.mock.calls[0];
  assert(call);
  expect(call[0]).toBe("https://sage.levanto.ai/decide");
  const body = call[1]?.body;
  assert(typeof body === "string");
  expect(JSON.parse(body)).toEqual({
    content: batch.state.type === "text" ? batch.state.text : "",
    question: { id: "q", kind: "yesno", instructions: "Is this urgent?" },
    reasoning: "off",
  });
  expect(new Headers(call[1]?.headers).get("authorization")).toBe("Bearer synthetic-prepared-key");
});
it("preserves prepared URL prefixes and private effective headers, without credential fallback", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(reported));
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("LEVANTO_API_KEY", "synthetic-environment-must-not-be-used");
  const { provider, context } = fixture();
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
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
    "Bearer synthetic-effective-header",
  );
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-private-route")).toBe("prepared");
});
it("uses one native batch for mixed scalar kinds and retains partial failures and metadata", async () => {
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
          {
            ok: true,
            result: {
              id: "c",
              kind: "choice",
              result: {
                chosen: "a",
                probability: 0.7,
                probabilities: [
                  { option: "a", probability: 0.7 },
                  { option: "b", probability: 0.3 },
                ],
              },
              meta: { model: "levanto-sage-v1.3" },
            },
          },
          {
            ok: true,
            result: {
              id: "s",
              kind: "scale",
              result: {
                expectation: 2.41,
                confidence: 0.71,
                probabilities: [
                  { level: 0, probability: 0.02 },
                  { level: 1, probability: 0.03 },
                  { level: 2, probability: 0.49 },
                  { level: 3, probability: 0.44 },
                  { level: 4, probability: 0.02 },
                ],
              },
              meta: {},
            },
          },
          {
            ok: true,
            result: {
              id: "t",
              kind: "tags",
              result: {
                tags: [
                  { id: "a", applies: null, probability: 0.51 },
                  { id: "b", applies: true, probability: 0.99 },
                ],
              },
              meta: {},
            },
          },
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
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(native));
  vi.stubGlobal("fetch", fetch);
  const { provider, context } = fixture();
  const outcome = await provider.evaluate(input, context);
  assert(outcome.status === "ok");
  expect(validateDecisionResultV2(input, outcome.result)).toBe(true);
  expect(outcome.result.answers).toMatchObject({
    c: { choice: "a", probability: 0.7, probabilities: { a: 0.7, b: 0.3 } },
    s: { score: 2.41, confidence: 0.71, probabilities: [0.02, 0.03, 0.49, 0.44, 0.02] },
    t: {
      tags: [
        { id: "a", applies: null, probability: 0.51 },
        { id: "b", applies: true, probability: 0.99 },
      ],
    },
    failed: { type: "error", code: "provider-error" },
  });
  const serialized = JSON.stringify(outcome.result.metadata);
  expect(JSON.parse(serialized)).toEqual({ native });
  expect(outcome.result.usage).toMatchObject({ inputTokens: 41, outputTokens: 5 });
  expect(fetch).toHaveBeenCalledOnce();
  const call = fetch.mock.calls[0];
  assert(call);
  expect(call[0]).toBe("https://sage.levanto.ai/decide/batch");
  const body = call[1]?.body;
  assert(typeof body === "string");
  const sent = JSON.parse(body);
  expect(sent.requests).toHaveLength(1);
  expect(sent.requests[0].questions[0].instructions).toContain('"true":"Urgent"');
  expect(sent).not.toHaveProperty("reasoning");
  expect(sent).not.toHaveProperty("grounding");
  expect(sent.requests[0].questions.every((q: object) => !Object.hasOwn(q, "grounding"))).toBe(
    true,
  );
});
it.each([2, 26])(
  "executes a %i-level rubric and preserves its native distribution",
  async (count) => {
    const input: DecisionBatchV2 = {
      ...batch,
      questions: {
        score: { type: "score", criteria: Array.from({ length: count }, (_, i) => `Level ${i}`) },
      },
    };
    const probabilities = Array.from({ length: count }, (_, level) => ({
      level,
      probability: level === count - 1 ? 1 : 0,
    }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        id: "score",
        kind: "scale",
        result: { expectation: count - 1, confidence: 0.8, probabilities },
        meta: {},
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const { provider, context } = fixture();
    const outcome = await provider.evaluate(input, context);
    expect(outcome).toMatchObject({
      status: "ok",
      result: {
        answers: {
          score: {
            type: "score",
            score: count - 1,
            confidence: 0.8,
            probabilities: probabilities.map((entry) => entry.probability),
          },
        },
      },
    });
    assert(outcome.status === "ok");
    expect(outcome.result.usage).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    const body = fetch.mock.calls[0]?.[1]?.body;
    assert(typeof body === "string");
    expect(JSON.parse(body).question.levels).toEqual(
      Array.from({ length: count }, (_, level) => ({ level, description: `Level ${level}` })),
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
  const native = {
    id: "rank",
    kind: "sort",
    result: { sorted: ["b", "a"], confidence: null },
    meta: {},
  };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(native));
  vi.stubGlobal("fetch", fetch);
  const { provider, context } = fixture();
  await expect(provider.evaluate(input, context)).resolves.toMatchObject({
    status: "ok",
    result: { answers: { rank: { type: "sort", order: ["b", "a"], confidence: null } } },
  });
  expect(fetch).toHaveBeenCalledOnce();
});
it.each<DecisionBatchV2>([
  { ...batch, questions: { s: { type: "score", criteria: ["only"] } } },
  {
    ...batch,
    questions: { s: { type: "score", criteria: Array.from({ length: 27 }, () => "level") } },
  },
  {
    ...batch,
    questions: {
      c: {
        type: "choice",
        criteria: Object.fromEntries(Array.from({ length: 121 }, (_, i) => [String(i), null])),
      },
    },
  },
  {
    ...batch,
    questions: {
      t: {
        type: "tags",
        criteria: Object.fromEntries(Array.from({ length: 121 }, (_, i) => [String(i), null])),
      },
    },
  },
  { ...batch, questions: { s: { type: "sort" } } },
])("rejects unsupported native input before an effect %#", async (input) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { provider, context, probe } = fixture();
  await expect(provider.evaluate(input, context)).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
});
it("rejects a valid Box question before image probing or HTTP", async () => {
  const input: DecisionBatchV2 = {
    state: {
      type: "image",
      dataUri:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAK0lEQVR4nO3OIQEAAAwEoetfeovxBoGnq1tKQEBAQEBAQEBAQEBAQEBgHXhUDfhqRFDd3gAAAABJRU5ErkJggg==",
    },
    questions: { target: { type: "box", instructions: "the red square" } },
  };
  expect(validateDecisionBatchV2(input)).toBe(true);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { provider, context, probe } = fixture();
  await expect(provider.evaluate(input, context)).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(probe).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("uses the common image probe once and rejects invalid dimensions before HTTP", async () => {
  const input: DecisionBatchV2 = {
    ...batch,
    state: {
      type: "image",
      dataUri:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=",
    },
  };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(reported));
  vi.stubGlobal("fetch", fetch);
  const { provider, context, probe } = fixture();
  await expect(provider.evaluate(input, context)).resolves.toMatchObject({ status: "ok" });
  expect(probe).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
  probe.mockResolvedValue({ width: 8193, height: 1 });
  fetch.mockClear();
  await expect(provider.evaluate(input, context)).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["false", "throw"])(
  "stops after image preparation when host admission returns %s",
  async (kind) => {
    const started = createDeferred<void>();
    const dimensions = createDeferred<{ width: number; height: number }>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(reported));
    vi.stubGlobal("fetch", fetch);
    const { provider, context, probe } = fixture();
    probe.mockImplementationOnce(() => {
      started.resolve();
      return dimensions.promise;
    });
    let admitted = true;
    const authorityError = new Error("synthetic owner closed during image preparation");
    const pending = provider.evaluate(
      {
        ...batch,
        state: {
          type: "image",
          dataUri:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=",
        },
      },
      {
        ...context,
        isAdmissible: () => {
          if (!admitted && kind === "throw") {
            throw authorityError;
          }
          return admitted;
        },
      },
    );
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
it.each([401, 402, 429, 503])(
  "classifies HTTP %s without retries or private diagnostics",
  async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ detail: "synthetic-prepared-key private-evidence" }, { status }),
      );
    vi.stubGlobal("fetch", fetch);
    const { provider, context } = fixture();
    const outcome = await provider.evaluate(batch, context);
    expect(outcome).toMatchObject({
      status: "unavailable",
      reason: status === 401 ? "authentication" : status === 429 ? "rate-limited" : "transport",
    });
    expect(JSON.stringify(outcome)).not.toContain("private-evidence");
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it("rejects malformed native output instead of guessing an answer", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...reported, id: "wrong" })));
  const { provider, context } = fixture();
  await expect(provider.evaluate(batch, context)).resolves.toEqual({
    status: "unavailable",
    reason: "invalid-response",
  });
});
it.each(["abort", "deadline"])(
  "bounds the registered whole response and releases on %s",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const started = createDeferred<void>();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream(
            {
              pull() {
                started.resolve();
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
        ),
      ),
    );
    const { provider, context } = fixture();
    const controller = new AbortController();
    const pending = provider.evaluate(batch, { ...context, signal: controller.signal });
    const settled =
      kind === "abort"
        ? expect(pending).rejects.toThrow("caller closed")
        : expect(pending).resolves.toEqual({ status: "unavailable", reason: "transport" });
    await started.promise;
    if (kind === "abort") {
      controller.abort(new Error("caller closed"));
    } else {
      await vi.advanceTimersByTimeAsync(501);
    }
    await settled;
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["abort", "deadline"])(
  "settles a pending image probe on %s without later HTTP",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const started = createDeferred<void>();
    const probeResult = createDeferred<{ width: number; height: number }>();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { provider, context, probe } = fixture();
    probe.mockImplementationOnce(() => {
      started.resolve();
      return probeResult.promise;
    });
    const input: DecisionBatchV2 = {
      ...batch,
      state: {
        type: "image",
        dataUri:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=",
      },
    };
    const controller = new AbortController();
    const pending = provider.evaluate(input, { ...context, signal: controller.signal });
    const settled =
      kind === "abort"
        ? expect(pending).rejects.toThrow("caller closed")
        : expect(pending).resolves.toEqual({ status: "unavailable", reason: "transport" });
    await started.promise;
    if (kind === "abort") {
      controller.abort(new Error("caller closed"));
    } else {
      await vi.advanceTimersByTimeAsync(501);
    }
    await settled;
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    probeResult.resolve({ width: 1, height: 1 });
    await probeResult.promise;
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(["levanto", "Levanto"])(
  "consumes prepared SecretRef/auth headers for %s without replaying config credentials",
  async (providerId) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(reported));
    vi.stubGlobal("fetch", fetch);
    const { provider, context } = fixture();
    const outcome = await provider.evaluate(batch, {
      ...context,
      model: {
        ...context.model,
        headers: {
          "X-Prepared-Auth": "synthetic-resolved-auth",
          "X-Managed": "synthetic-resolved-header",
        },
      },
      config: {
        models: {
          providers: {
            [providerId]: {
              baseUrl: "https://sage.levanto.ai",
              models: [],
              headers: {
                "X-Managed": { source: "env", provider: "default", id: "SAGE_HEADER_FIXTURE" },
              },
              request: {
                headers: { "X-Managed": "must-not-replay" },
                auth: {
                  mode: "header",
                  headerName: "X-Prepared-Auth",
                  value: { source: "env", provider: "default", id: "SAGE_AUTH_FIXTURE" },
                },
              },
            },
          },
        },
      },
    });
    expect(outcome.status).toBe("ok");
    expect(fetch).toHaveBeenCalledOnce();
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Prepared-Auth")).toBe("synthetic-resolved-auth");
    expect(headers.get("X-Managed")).toBe("synthetic-resolved-header");
    expect(headers.has("authorization")).toBe(false);
  },
);

it("keeps prepared bearer auth for an explicit provider-default policy", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(reported));
  vi.stubGlobal("fetch", fetch);
  const { provider, context } = fixture();
  const outcome = await provider.evaluate(batch, {
    ...context,
    config: {
      models: {
        providers: {
          levanto: {
            baseUrl: "https://sage.levanto.ai",
            models: [],
            request: { auth: { mode: "provider-default" } },
          },
        },
      },
    },
  });
  expect(outcome.status).toBe("ok");
  expect(fetch).toHaveBeenCalledOnce();
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
    "Bearer synthetic-prepared-key",
  );
});
