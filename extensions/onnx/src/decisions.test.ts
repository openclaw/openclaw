import { decisionBatchV1ToV2 } from "openclaw/plugin-sdk/decisions";
import type { DecisionBatch, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { beforeEach, expect, it, vi } from "vitest";
import { createOnnxProvider, createPreparedOnnxProvider } from "./decisions.js";
import { OnnxWorkerError } from "./protocol.js";
import type { InferenceWorkerClient } from "./worker-client.js";

const model = "gliclass-edge-v3.0";
const context = () => ({
  model,
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 1000,
});
const unavailable = { status: "unavailable", reason: "unsupported-input" };
const classify = vi.fn<InferenceWorkerClient["classify"]>();
const warn = vi.fn();
const provider = createOnnxProvider({ classify }, warn);
const prepared = createPreparedOnnxProvider({ classify }, warn);
beforeEach(() => vi.resetAllMocks());

const preparedContext = (): DecisionProviderContextV2 => ({
  ...context(),
  model: { id: model, provider: "onnx", name: "GLiClass Edge" },
  config: {},
  auth: { apiKey: "onnx-local", mode: "api-key" },
  isAdmissible: () => true,
});

it("preserves classifier estimates and the physical worker admission callback", async () => {
  classify.mockResolvedValue([
    { logits: [Math.log(3), 0], inputTokens: 12 },
    { logits: [0, Math.log(2), Math.log(7)], inputTokens: 15 },
    { logits: [Math.log(4), 0], inputTokens: 14 },
  ]);
  const input = decisionBatchV1ToV2(batch)!;
  const ctx = preparedContext();
  const result = await prepared.evaluate(input, ctx);
  expect(result).toEqual({
    status: "ok",
    result: {
      model,
      answers: {
        topic: {
          type: "choice",
          choice: "holiday",
          probabilities: { holiday: expect.closeTo(0.75, 14), finance: expect.closeTo(0.25, 14) },
        },
        rating: {
          type: "score",
          score: expect.closeTo(1.6),
          probabilities: [expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.7)],
        },
        mentioned: { type: "boolean", probabilityTrue: 0.8 },
      },
      usage: { inputTokens: 41 },
    },
  });
  expect(classify).toHaveBeenCalledWith(model, expect.any(Array), ctx.signal, ctx.isAdmissible);
  expect(classify.mock.calls[0]?.[1][0]).toMatchObject({
    text: '{"message":"A pleasant holiday"}',
    labels: ["holiday", "finance"],
  });
});

it("keeps per-model limits and canonical billing facts during V1 catalog enrichment", async () => {
  type Decision = NonNullable<
    NonNullable<DecisionProviderContextV2["model"]["inference"]>["decision"]
  >;
  const entry = (id: string, decision: Decision) => ({
    id,
    name: id,
    provider: "onnx",
    inference: { chat: false as const, decision },
  });
  const native = entry("pinned", {
    protocol: "pinned",
    input: ["text"],
    billing: { unit: "tokens", source: "provider-docs", usdPerMillion: { input: 0.01 } },
  });
  const question = {
    probabilities: "provider-defined" as const,
    abstention: false,
    maxOptions: 64,
  };
  const legacy = entry("deberta-v3-base-zeroshot-v2.0", {
    protocol: "decision-v1",
    input: ["text"],
    questions: { choice: question, score: question },
    limits: {
      maxQuestions: 32,
      maxInputTokens: 512,
      inputTokenScope: "state-plus-each-criterion",
    },
  });
  const rows = await prepared.provider?.augmentModelCatalog?.({
    env: {},
    entries: [native, legacy],
  });
  expect(rows?.find((row) => row.id === "pinned")).toEqual(native);
  expect(rows?.find((row) => row.id === legacy.id)?.inference?.decision).toMatchObject({
    protocol: "onnx-classifier",
    questions: {
      choice: { probabilities: "categorical", minOptions: 2, maxOptions: 64 },
      score: { probabilities: "categorical", minOptions: 2, maxOptions: 64 },
    },
    limits: legacy.inference.decision.limits,
  });
});
const batch: DecisionBatch = {
  state: { message: "A pleasant holiday" },
  questions: {
    topic: { type: "choice", criteria: { holiday: "travel", finance: null } },
    rating: { type: "score", criteria: ["negative", "neutral", "positive"] },
    mentioned: { type: "boolean", criteria: { true: "holiday", false: "no holiday" } },
  },
};

it.each(["list", "reasoning", "bare Boolean"] as const)(
  "rejects %s before dispatch",
  async (kind) => {
    const input = decisionBatchV1ToV2(batch)!;
    const result =
      kind === "bare Boolean"
        ? await provider.evaluate(
            { ...batch, questions: { ...batch.questions, bare: { type: "boolean" } } },
            context(),
          )
        : await prepared.evaluate(
            kind === "list"
              ? { ...input, state: { type: "list", items: [{ id: "one", content: "first" }] } }
              : input,
            kind === "reasoning" ? { ...preparedContext(), reasoning: "on" } : preparedContext(),
          );
    expect(result).toEqual(unavailable);
    expect(classify).not.toHaveBeenCalled();
  },
);

it("preserves arbitrary question and label keys without prototype assignment", async () => {
  classify.mockResolvedValue([{ logits: [1000, -1000], inputTokens: 3 }]);
  const questions = {
    ["__proto__"]: {
      type: "choice" as const,
      criteria: { ["__proto__"]: "first", constructor: "second" },
    },
  };
  const result = await provider.evaluate({ state: "text", questions }, context());
  if (result.status !== "ok") {
    throw new Error("Expected an available provider");
  }
  expect(Object.keys(result.result.answers)).toEqual(["__proto__"]);
  expect(Object.getOwnPropertyDescriptor(result.result.answers, "__proto__")?.value).toEqual({
    type: "choice",
    choice: "__proto__",
    probabilities: { ["__proto__"]: 1, constructor: 0 },
  });
});

it.each(["canceled", "model-missing"] as const)("handles %s distinctly", async (failure) => {
  const controller = new AbortController();
  classify.mockImplementation(async () => {
    if (failure === "canceled") {
      controller.abort(new Error("caller cancelled"));
    }
    throw new OnnxWorkerError(failure === "canceled" ? "runtime" : failure);
  });
  const outcome = provider.evaluate(batch, { ...context(), signal: controller.signal });
  if (failure === "canceled") {
    await expect(outcome).rejects.toThrow("caller cancelled");
  } else {
    await expect(outcome).resolves.toEqual({ status: "unavailable", reason: "transport" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`openclaw onnx verify ${model}`));
  }
});
