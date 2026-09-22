import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";
import { describe, expect, it, vi } from "vitest";
import { createOnnxProvider } from "./decisions.js";
import { OnnxWorkerError } from "./protocol.js";
import type { InferenceWorkerClient } from "./worker-client.js";

const model = "gliclass-edge-v3.0";
const context = () => ({
  model,
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 1000,
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
    expect(result.result.answers.rating).toMatchObject({ type: "score" });
    const rating = result.result.answers.rating;
    if (rating?.type !== "score") {
      throw new Error("Expected score result");
    }
    expect(rating.score).toBeCloseTo(1.6);
    expect(rating.probabilities).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.7),
    ]);
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
    const questions = Object.fromEntries([
      [
        "__proto__",
        {
          type: "choice" as const,
          criteria: Object.fromEntries([
            ["__proto__", "first"],
            ["constructor", "second"],
          ]),
        },
      ],
    ]);
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
      probabilities: Object.fromEntries([
        ["__proto__", 1],
        ["constructor", 0],
      ]),
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

  it.for([[], [{ logits: [Number.NaN, 1], inputTokens: 1 }]])(
    "rejects incomplete or invalid results",
    async (results) => {
      const classify = vi.fn<InferenceWorkerClient["classify"]>().mockResolvedValue(results);
      await expect(
        createOnnxProvider({ classify }, vi.fn()).evaluate(
          { state: "text", questions: { one: batch.questions.topic! } },
          context(),
        ),
      ).resolves.toEqual({ status: "unavailable", reason: "invalid-response" });
    },
  );
});
