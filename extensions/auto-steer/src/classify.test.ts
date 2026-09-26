import type { DecisionRuntimeV1 } from "openclaw/plugin-sdk/decisions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyInputRoute } from "./classify.js";

const event = {
  currentTurn: [{ role: "user" as const, text: "Write a parser." }],
  newMessage: "Also handle tabs.",
};
const context = () => ({
  agentId: "support",
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 500,
  assertCurrent: vi.fn(),
});
beforeEach(() => vi.spyOn(performance, "now").mockReturnValue(1_000));
afterEach(() => vi.restoreAllMocks());
describe("Auto feature decision consumer", () => {
  it("makes one first-class decision and trusts its label, not an argmax", async () => {
    const evaluate = vi.fn<DecisionRuntimeV1["evaluate"]>().mockResolvedValue({
      status: "ok",
      result: {
        model: "test",
        answers: {
          delivery: {
            type: "choice",
            choice: "steer",
            probabilities: { steer: 0.2, followup: 0.9, abstain: 0.1 },
          },
        },
      },
      provenance: { providerId: "test", rubricVersion: "auto-steer-v2", runtimeGeneration: "test" },
    });
    const ctx = context();
    expect(await classifyInputRoute({ evaluate }, event, ctx)).toEqual({
      status: "choice",
      choice: "steer",
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ state: event }),
      expect.objectContaining({
        agentId: "support",
        purpose: "message.steer",
        signal: ctx.signal,
      }),
    );
  });
  it("preserves explicit successful abstention without choosing a probability winner", async () => {
    const evaluate = vi.fn<DecisionRuntimeV1["evaluate"]>().mockResolvedValue({
      status: "ok",
      result: {
        model: "test",
        answers: {
          delivery: {
            type: "choice",
            choice: "abstain",
            probabilities: { steer: 0.8, followup: 0.2, abstain: 0.1 },
          },
        },
      },
      provenance: { providerId: "test", rubricVersion: "auto-steer-v2", runtimeGeneration: "test" },
    });
    expect(await classifyInputRoute({ evaluate }, event, context())).toEqual({
      status: "abstained",
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
  it("does not turn cancellation or programmer errors into fallback", async () => {
    const error = new Error("authority revoked");
    const evaluate = vi.fn<DecisionRuntimeV1["evaluate"]>().mockRejectedValue(error);
    await expect(classifyInputRoute({ evaluate }, event, context())).rejects.toBe(error);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
  it("does no provider work after preparation exhausts the shared deadline", async () => {
    const evaluate = vi.fn<DecisionRuntimeV1["evaluate"]>();
    expect(
      await classifyInputRoute({ evaluate }, event, { ...context(), deadlineMonotonicMs: -1 }),
    ).toEqual({ status: "unavailable", reason: "deadline" });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it("preserves unavailable without retry or a second model", async () => {
    const evaluate = vi
      .fn<DecisionRuntimeV1["evaluate"]>()
      .mockResolvedValue({ status: "unavailable", reason: "overloaded" });
    expect(await classifyInputRoute({ evaluate }, event, context())).toEqual({
      status: "unavailable",
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
