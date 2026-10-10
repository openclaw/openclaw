import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate } from "./client.js";
import { createDecisionProvider } from "./decisions.js";
import { EvaluationError } from "./errors.js";
vi.mock("./client.js", () => ({ evaluate: vi.fn() }));
const batch: DecisionBatch = {
  state: "synthetic",
  questions: { b: { type: "boolean" } },
};
const context = () => ({
  model: "jev-agent-selected",
  agentId: "research",
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 500,
});
const config = { apiKey: "synthetic-key", timeoutMs: 2000 };
beforeEach(() => {
  vi.mocked(evaluate).mockReset();
});
describe("host decision adapter", () => {
  it("does not convert caller cancellation or implementation errors into fallback", async () => {
    const controller = new AbortController();
    vi.mocked(evaluate).mockImplementation(async () => {
      controller.abort(new Error("caller closed"));
      throw new EvaluationError("cancelled", "transport");
    });
    await expect(
      createDecisionProvider(() => config).evaluate(batch, {
        ...context(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller closed");
    vi.mocked(evaluate).mockRejectedValue(new Error("private detail"));
    const failure = createDecisionProvider(() => config).evaluate(batch, context());
    await expect(failure).rejects.toMatchObject({
      name: "Error",
      message: "TypeSafe decision adapter contract failure.",
    });
    await expect(failure).rejects.not.toHaveProperty("cause");
  });
});
