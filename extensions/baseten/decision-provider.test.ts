import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  DecisionProviderV2,
} from "openclaw/plugin-sdk/decisions";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import basetenPlugin from "./index.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), release: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  fetchWithProviderHttpGuard: async (request: {
    beforeRequest: () => void;
    url: string;
    init: RequestInit;
    signal: AbortSignal;
  }) => {
    request.beforeRequest();
    return {
      response: await mocks.fetch(request.url, { ...request.init, signal: request.signal }),
      release: mocks.release,
    };
  },
}));
const ids = [
  "decision-models/baseten-elephant-9b-latest",
  "decision-models/baseten-mammoth-27b-latest",
];
const batch: DecisionBatchV2 = {
  state: { type: "json", value: { ticket: "Refund the duplicate charge" } },
  questions: {
    refund: { type: "boolean", instructions: "Is a refund requested?" },
    route: {
      type: "choice",
      instructions: "Choose a team",
      criteria: { billing: "Payments", support: "Technical" },
    },
    urgency: { type: "score", instructions: "Rate urgency", criteria: ["Routine", "Emergency"] },
  },
};
function reply() {
  return {
    model: "elephant-1",
    answers: {
      refund: { type: "noul", noul: 0.98 },
      route: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.9, support: 0.1 },
        confidence: 0.8,
      },
      urgency: {
        type: "score",
        score: 0.2,
        probabilities: { "0": 0.8, "1": 0.2 },
        legend: { "0": "Routine", "1": "Emergency" },
        confidence: 0.6,
      },
    },
    usage: { input_tokens: 42, output_tokens: 3 },
  };
}
function context(
  id = ids[0]!,
  extra: Partial<DecisionProviderContextV2> = {},
): DecisionProviderContextV2 {
  return {
    model: { provider: "baseten", id, name: id, baseUrl: "https://inference.baseten.co/v1" },
    auth: { apiKey: "synthetic-baseten-key", mode: "api-key" },
    config: {},
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 30_000,
    isAdmissible: () => true,
    ...extra,
  };
}
function registered() {
  const captured = createCapturedPluginRegistration();
  let decision: DecisionProviderV2 | undefined;
  basetenPlugin.register({
    ...captured.api,
    registerDecisionProvider: (provider) => {
      if (provider.contractVersion === 2) {
        decision = provider;
      }
    },
  });
  expect(decision, "Baseten must register native decisions, not chat completions").toBeDefined();
  return decision!;
}
beforeEach(() => {
  mocks.fetch.mockReset().mockImplementation(async () => Response.json(reply()));
  mocks.release.mockReset();
});
it.each(ids)("evaluates %s through registered System One transport", async (id) => {
  const result = await registered().evaluate(batch, context(id));
  expect(result).toEqual({
    status: "ok",
    result: {
      model: "elephant-1",
      answers: {
        refund: { type: "boolean", probabilityTrue: 0.98 },
        route: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.9, support: 0.1 },
          confidence: 0.8,
        },
        urgency: { type: "score", score: 0.2, probabilities: [0.8, 0.2], confidence: 0.6 },
      },
      usage: { inputTokens: 42, outputTokens: 3 },
    },
  });
  const [url, init] = mocks.fetch.mock.calls[0]!;
  expect(url).toBe("https://inference.baseten.co/v1/systemone");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-baseten-key");
  expect(JSON.parse(init.body)).toEqual({
    model: id,
    state: '{"ticket":"Refund the duplicate charge"}',
    questions: {
      refund: { type: "noul", instructions: "Is a refund requested?" },
      route: {
        type: "choice",
        instructions: "Choose a team",
        criteria: { billing: "Payments", support: "Technical" },
      },
      urgency: { type: "score", instructions: "Rate urgency", criteria: ["Routine", "Emergency"] },
    },
  });
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(mocks.release).toHaveBeenCalledOnce();
});

it.each([401, 429, 422, 503])(
  "classifies HTTP %s without retrying or exposing provider bodies",
  async (status) => {
    mocks.fetch.mockResolvedValue(
      new Response("private provider error", { status, headers: { "retry-after": "2" } }),
    );
    expect(await registered().evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason:
        status === 401
          ? "authentication"
          : status === 429
            ? "rate-limited"
            : status === 422
              ? "unsupported-input"
              : "transport",
      ...(status === 429 ? { retryAfterMs: 2000 } : {}),
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  },
);
it("rejects malformed distributions, usage, and reflected credentials", async () => {
  for (const payload of [
    { ...reply(), answers: { ...reply().answers, refund: { type: "noul", noul: 2 } } },
    {
      ...reply(),
      answers: {
        ...reply().answers,
        route: { ...reply().answers.route, probabilities: { billing: 1 } },
      },
    },
    {
      ...reply(),
      answers: {
        ...reply().answers,
        urgency: { ...reply().answers.urgency, legend: { "0": "Wrong", "1": "Emergency" } },
      },
    },
    { ...reply(), usage: { input_tokens: 42, output_tokens: 0 } },
    { ...reply(), model: "synthetic-baseten-key" },
  ]) {
    mocks.fetch.mockResolvedValue(Response.json(payload));
    expect(await registered().evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "invalid-response",
    });
  }
});
it("does not dispatch unsupported model, input, reasoning, or missing credentials", async () => {
  const provider = registered();
  for (const [input, ctx, reason] of [
    [batch, context("deepseek-ai/DeepSeek-V4.1-Flash"), "unsupported-input"],
    [{ ...batch, state: { type: "list", items: [] } }, context(), "unsupported-input"],
    [batch, context(undefined, { reasoning: "on" }), "unsupported-input"],
    [batch, context(undefined, { auth: { mode: "api-key" } }), "credentials-unavailable"],
  ] as const) {
    expect(await provider.evaluate(input, ctx)).toEqual({ status: "unavailable", reason });
  }
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("checks authority at dispatch and preserves cancellation and terminal authority errors", async () => {
  expect(
    await registered().evaluate(batch, context(undefined, { isAdmissible: () => false })),
  ).toEqual({ status: "unavailable", reason: "transport" });
  const authorityError = new Error("authority retired");
  await expect(
    registered().evaluate(
      batch,
      context(undefined, {
        isAdmissible: () => {
          throw authorityError;
        },
      }),
    ),
  ).rejects.toBe(authorityError);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    registered().evaluate(batch, context(undefined, { signal: controller.signal })),
  ).rejects.toThrow("cancelled");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
