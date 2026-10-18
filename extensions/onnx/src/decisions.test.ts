import { decisionBatchV1ToV2 } from "openclaw/plugin-sdk/decisions";
import type { DecisionBatch, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { describe, expect, it, vi } from "vitest";
import { createOnnxProvider, createPreparedOnnxProvider } from "./decisions.js";
import { OnnxWorkerError } from "./protocol.js";
import type { InferenceWorkerClient } from "./worker-client.js";

const model = "gliclass-edge-v3.0";
const context = () => ({
  model,
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 1000,
});

describe("ONNX prepared decision contract", () => {
  const preparedContext = (): DecisionProviderContextV2 => ({
    ...context(),
    model: { id: model, provider: "onnx", name: "GLiClass Edge" },
    config: {},
    auth: { apiKey: "onnx-local", mode: "api-key" },
    isAdmissible: () => true,
  });

  it("preserves classifier estimates and the physical worker admission callback", async () => {
    const classify = vi.fn<InferenceWorkerClient["classify"]>().mockResolvedValue([
      { logits: [Math.log(3), 0], inputTokens: 12 },
      { logits: [0, Math.log(2), Math.log(7)], inputTokens: 15 },
      { logits: [Math.log(4), 0], inputTokens: 14 },
    ]);
    const input = decisionBatchV1ToV2(batch)!;
    const ctx = preparedContext();
    const result = await createPreparedOnnxProvider({ classify }, vi.fn()).evaluate(input, ctx);
    expect(result).toMatchObject({
      status: "ok",
      result: {
        model,
        answers: {
          topic: { type: "choice", choice: "holiday" },
          rating: { type: "score", score: expect.closeTo(1.6) },
          mentioned: { type: "boolean", probabilityTrue: 0.8 },
        },
        usage: { inputTokens: 41 },
      },
    });
    expect(classify).toHaveBeenCalledWith(model, expect.any(Array), ctx.signal, ctx.isAdmissible);
  });

  it("rejects unsupported V2 content and reasoning before worker dispatch", async () => {
    const classify = vi.fn<InferenceWorkerClient["classify"]>();
    const provider = createPreparedOnnxProvider({ classify }, vi.fn());
    const input = decisionBatchV1ToV2(batch)!;
    await expect(
      provider.evaluate(
        { ...input, state: { type: "list", items: [{ id: "one", content: "first" }] } },
        preparedContext(),
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
    await expect(
      provider.evaluate(input, { ...preparedContext(), reasoning: "on" }),
    ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(classify).not.toHaveBeenCalled();
  });

  it("keeps per-model limits and canonical billing facts during V1 catalog enrichment", async () => {
    const native = {
      provider: "onnx",
      id: "pinned",
      name: "Pinned",
      inference: {
        chat: false as const,
        decision: {
          protocol: "pinned",
          input: ["text" as const],
          billing: {
            unit: "tokens" as const,
            source: "provider-docs" as const,
            usdPerMillion: { input: 0.01 },
          },
        },
      },
    };
    const legacy = {
      provider: "onnx",
      id: "deberta-v3-base-zeroshot-v2.0",
      name: "DeBERTa",
      inference: {
        chat: false as const,
        decision: {
          protocol: "decision-v1",
          input: ["text" as const],
          questions: {
            choice: {
              probabilities: "provider-defined" as const,
              abstention: false,
              maxOptions: 64,
            },
            score: {
              probabilities: "provider-defined" as const,
              abstention: false,
              maxOptions: 64,
            },
          },
          limits: {
            maxQuestions: 32,
            maxInputTokens: 512,
            inputTokenScope: "state-plus-each-criterion" as const,
          },
        },
      },
    };
    const provider = createPreparedOnnxProvider({ classify: vi.fn() }, vi.fn());
    const rows = await provider.provider?.augmentModelCatalog?.({
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
});
const batch: DecisionBatch = {
  state: { message: "A pleasant holiday" },
  questions: {
    topic: { type: "choice", criteria: { holiday: "travel", finance: null } },
    rating: { type: "score", criteria: ["negative", "neutral", "positive"] },
    mentioned: {
      type: "boolean",
      criteria: { true: "A holiday is mentioned", false: "No holiday is mentioned" },
    },
  },
};

describe("ONNX decision contract", () => {
  it("returns complete distributions and computes ordered scores from actual logits", async () => {
    const classify = vi.fn<InferenceWorkerClient["classify"]>().mockResolvedValue([
      { logits: [Math.log(3), 0], inputTokens: 12 },
      { logits: [0, Math.log(2), Math.log(7)], inputTokens: 15 },
      { logits: [Math.log(4), 0], inputTokens: 14 },
    ]);
    const result = await createOnnxProvider({ classify }, vi.fn()).evaluate(batch, context());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("Expected an available provider");
    }
    expect(result.result.answers.topic).toEqual({
      type: "choice",
      choice: "holiday",
      probabilities: { holiday: expect.closeTo(0.75, 14), finance: expect.closeTo(0.25, 14) },
    });
    expect(result.result.answers.rating).toEqual({
      type: "score",
      score: expect.closeTo(1.6),
      probabilities: [expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.7)],
    });
    expect(result.result.answers.mentioned).toEqual({ type: "boolean", probabilityTrue: 0.8 });
    expect(result.result.usage).toEqual({ inputTokens: 41 });
    expect(classify.mock.calls[0]?.[0]).toBe(model);
    expect(classify.mock.calls[0]?.[1][0]).toMatchObject({
      text: '{"message":"A pleasant holiday"}',
      labels: ["holiday", "finance"],
    });
  });

  it("rejects an entire batch with an undescribed Boolean predicate before dispatch", async () => {
    const classify = vi.fn<InferenceWorkerClient["classify"]>();
    const provider = createOnnxProvider({ classify }, vi.fn());
    await expect(
      provider.evaluate(
        { ...batch, questions: { ...batch.questions, bare: { type: "boolean" } } },
        context(),
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(classify).not.toHaveBeenCalled();
  });

  it("preserves arbitrary question and label keys without prototype assignment", async () => {
    const classify = vi
      .fn<InferenceWorkerClient["classify"]>()
      .mockResolvedValue([{ logits: [1000, -1000], inputTokens: 3 }]);
    const questions = {
      ["__proto__"]: {
        type: "choice" as const,
        criteria: { ["__proto__"]: "first", constructor: "second" },
      },
    };
    const result = await createOnnxProvider({ classify }, vi.fn()).evaluate(
      { state: "text", questions },
      context(),
    );
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

  it("keeps caller cancellation distinct from model unavailability", async () => {
    const controller = new AbortController();
    const classify = vi.fn<InferenceWorkerClient["classify"]>().mockImplementation(async () => {
      controller.abort(new Error("caller cancelled"));
      throw new OnnxWorkerError("runtime");
    });
    await expect(
      createOnnxProvider({ classify }, vi.fn()).evaluate(batch, {
        ...context(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller cancelled");
  });

  it("reports missing artifacts with an actionable setup message", async () => {
    const classify = vi
      .fn<InferenceWorkerClient["classify"]>()
      .mockRejectedValue(new OnnxWorkerError("model-missing"));
    const warn = vi.fn();
    await expect(
      createOnnxProvider({ classify }, warn).evaluate(batch, context()),
    ).resolves.toEqual({ status: "unavailable", reason: "transport" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`openclaw onnx verify ${model}`));
  });
});
