import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  DecisionProviderV2,
} from "openclaw/plugin-sdk/decisions";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import googlePlugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  fetchWithProviderHttpGuard: async (request: { url: string; init: RequestInit }) => ({
    response: await mocks.fetch(request.url, request.init),
    release: async () => {},
  }),
}));

const decisionRow = manifest.modelCatalog.providers.google.models.find(
  (model) => model.id === "gemini-decision-1",
)!;
const batch: DecisionBatchV2 = {
  state: { type: "json", value: { message: "Audio cuts out on the left earcup." } },
  questions: {
    is_defect: {
      type: "boolean",
      instructions: "Does `message` describe a hardware defect?",
      criteria: { true: "The product is broken.", false: "Preference or shipping complaint." },
    },
    next_action: {
      type: "choice",
      instructions: "What is the right resolution?",
      criteria: { replacement: "Ship a replacement.", human_escalation: null },
    },
    churn_risk: {
      type: "score",
      instructions: "How likely is the customer to churn?",
      criteria: ["No churn signal", "Threatens to cancel"],
    },
  },
};
function reply() {
  return {
    answers: {
      is_defect: { type: "noul", noul: 0.94, confidence: 0.94 },
      next_action: {
        type: "choice",
        choice: "human_escalation",
        probabilities: { human_escalation: 0.76, replacement: 0.24 },
        confidence: 0.76,
      },
      churn_risk: {
        type: "score",
        score: 0.99,
        legend: { "0": "No churn signal", "1": "Threatens to cancel" },
        probabilities: { "0": 0.01, "1": 0.99 },
        confidence: 0.99,
      },
    },
    usage: {
      total_input_tokens: 324,
      input_tokens_by_modality: [{ modality: "text", tokens: 324 }],
      total_output_tokens: 0,
      total_tokens: 324,
    },
  };
}
function withAnswer(name: keyof ReturnType<typeof reply>["answers"], fields: object) {
  const payload = reply();
  return {
    ...payload,
    answers: { ...payload.answers, [name]: { ...payload.answers[name], ...fields } },
  };
}
function context(extra: Partial<DecisionProviderContextV2> = {}): DecisionProviderContextV2 {
  return {
    model: {
      provider: "google",
      id: "gemini-decision-1",
      name: "Gemini Decision 1",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      inference: decisionRow.inference as NonNullable<
        DecisionProviderContextV2["model"]["inference"]
      >,
    },
    auth: { apiKey: "synthetic-gemini-key", mode: "api-key" },
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
  googlePlugin.register({
    ...captured.api,
    registerDecisionProvider: (provider) => {
      if (provider.contractVersion === 2) {
        decision = provider;
      }
    },
  });
  expect(decision?.id).toBe("google");
  return decision!;
}
beforeEach(() => {
  mocks.fetch.mockReset().mockImplementation(async () => Response.json(reply()));
});

it("evaluates typed questions through the native Decisions endpoint", async () => {
  expect(await registered().evaluate(batch, context())).toEqual({
    status: "ok",
    result: {
      model: "gemini-decision-1",
      answers: {
        is_defect: { type: "boolean", probabilityTrue: 0.94 },
        next_action: {
          type: "choice",
          choice: "human_escalation",
          probabilities: { human_escalation: 0.76, replacement: 0.24 },
          confidence: 0.76,
        },
        churn_risk: { type: "score", score: 0.99, probabilities: [0.01, 0.99], confidence: 0.99 },
      },
      usage: { inputTokens: 324, outputTokens: 0 },
    },
  });
  const [url, init] = mocks.fetch.mock.calls[0]!;
  expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
  expect(new Headers(init.headers).get("x-goog-api-key")).toBe("synthetic-gemini-key");
  expect(JSON.parse(init.body)).toEqual({
    model: "gemini-decision-1",
    input: '{"message":"Audio cuts out on the left earcup."}',
    questions: {
      is_defect: {
        type: "noul",
        instructions: "Does `message` describe a hardware defect?",
        criteria: {
          true_description: "The product is broken.",
          false_description: "Preference or shipping complaint.",
        },
      },
      next_action: batch.questions.next_action,
      churn_risk: batch.questions.churn_risk,
    },
  });
});

it("asks the rubric itself when optional instructions are omitted", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json({
      answers: {
        route: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 },
        level: {
          type: "score",
          score: 0.1,
          legend: { "0": "Low", "1": "High" },
          probabilities: { "0": 0.9, "1": 0.1 },
          confidence: 0.9,
        },
        urgent: { type: "noul", noul: 0.2, confidence: 0.8 },
      },
      usage: { total_input_tokens: 40, total_output_tokens: 0 },
    }),
  );
  const omitted: DecisionBatchV2 = {
    state: { type: "text", text: "Checkout is down." },
    questions: {
      route: { type: "choice", criteria: { a: "A", b: "B" } },
      level: { type: "score", criteria: ["Low", "High"] },
      urgent: { type: "boolean", criteria: { true: "Urgent", false: "Routine" } },
    },
  };
  expect(await registered().evaluate(omitted, context())).toMatchObject({ status: "ok" });
  const { questions } = JSON.parse(mocks.fetch.mock.calls[0]![1].body);
  expect(questions.route.instructions).toBe("Which option best fits the input?");
  expect(questions.level.instructions).toBe("Which level best describes the input?");
  expect(questions.urgent.instructions).toBe("Does the true description apply to the input?");
});

it("sends image evidence as inline content blocks", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json({
      answers: { visible_damage: { type: "noul", noul: 0.2, confidence: 0.8 } },
      usage: { total_input_tokens: 300, total_output_tokens: 0 },
    }),
  );
  const imageBatch: DecisionBatchV2 = {
    state: { type: "image", dataUri: "data:image/jpeg;base64,AAAA", text: "Return photo #8821." },
    questions: { visible_damage: { type: "boolean", instructions: "Is the device damaged?" } },
  };
  expect(await registered().evaluate(imageBatch, context())).toMatchObject({ status: "ok" });
  expect(JSON.parse(mocks.fetch.mock.calls[0]![1].body).input).toEqual([
    { type: "text", text: "Return photo #8821." },
    { type: "image", data: "AAAA", mime_type: "image/jpeg" },
  ]);
});

it.each([
  withAnswer("churn_risk", { legend: { "0": "Threatens to cancel", "1": "No churn signal" } }),
  { ...reply(), usage: { total_input_tokens: 324, total_output_tokens: 3 } },
])("rejects malformed results %#", async (payload) => {
  mocks.fetch.mockResolvedValue(Response.json(payload));
  expect(await registered().evaluate(batch, context())).toEqual({
    status: "unavailable",
    reason: "invalid-response",
  });
});

it("rejects batches the native wire cannot carry before dispatch", async () => {
  const provider = registered();
  const chatModel = { ...context().model, id: "gemini-3.5-flash", inference: { chat: true } };
  for (const [input, ctx, reason] of [
    [batch, context({ model: chatModel }), "unsupported-input"],
    [{ ...batch, state: { type: "list", items: [] } }, context(), "unsupported-input"],
    [
      {
        state: batch.state,
        questions: { urgent: { type: "boolean" } },
      },
      context(),
      "unsupported-input",
    ],
    [
      { state: batch.state, questions: { "bad key": batch.questions.is_defect! } },
      context(),
      "unsupported-input",
    ],
    [batch, context({ reasoning: "on" }), "unsupported-input"],
    [
      batch,
      context({ model: { ...context().model, baseUrl: "https://example.com/v1beta" } }),
      "transport",
    ],
  ] as const) {
    expect(await provider.evaluate(input as DecisionBatchV2, ctx)).toEqual({
      status: "unavailable",
      reason,
    });
  }
  expect(mocks.fetch).not.toHaveBeenCalled();
});
