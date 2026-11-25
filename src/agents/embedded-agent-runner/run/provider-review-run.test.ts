import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { testing } from "../../../sessions/session-controller.test-support.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { createProviderReviewRun } from "./provider-review-run.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const recordSessionProviderReview = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../sessions/provider-review.js", () => ({ recordSessionProviderReview }));
// This boundary settles queued work; admission, continuation and drain execution stay idle.
vi.mock("../../../config/sessions/lifecycle.js", () => ({
  resolveSessionWorkStartError: vi.fn(),
}));
vi.mock("./terminal-outcome.js", () => ({
  resolveEmbeddedRunAttemptTerminalOutcome: vi.fn(),
}));
vi.mock("../../../sessions/provider-review-terminal.js", () => ({
  captureAgentRunProviderReview: vi.fn(),
}));
vi.mock("../../model-thinking-default.js", () => ({
  resolveThinkingSelection: () => {
    throw new Error("Queue settlement must not refresh model selection");
  },
}));
vi.mock("../../../auto-reply/thinking.js", async () => {
  const { normalizeThinkLevel } = await import("../../../auto-reply/thinking.shared.js");
  return { normalizeThinkLevel };
});
vi.mock("../../../auto-reply/reply/queue/drain.js", () => ({
  clearFollowupDrainCallback: vi.fn(),
}));
afterEach(() => {
  testing.resetSessionControllerForTest();
});

it("settles a research precaution without clearing main's shared global queue", async () => {
  const sessionKey = "global";
  const sessionId = "research-session";
  const gate = createDeferred();
  const targets = {
    main: { agentId: "main", sessionId: "main-session", sessionKey, storePath: "/synthetic/main" },
    research: { agentId: "research", sessionId, sessionKey, storePath: "/synthetic/research" },
  };
  const entered = [createDeferred(), createDeferred()];
  const blockers = Object.values(targets).map((target, index) =>
    withSessionTurn(target, async () => {
      entered[index]!.resolve();
      await gate.promise;
    }),
  );
  await Promise.all(entered.map((entry) => entry.promise));
  const executed: string[] = [];
  const commands = ["main", "research", undefined].map((agentId) =>
    withSessionTurn(targets[agentId === "research" ? "research" : "main"], async () => {
      executed.push(agentId ?? "untagged main");
    }),
  );
  const settled = Promise.allSettled(commands);
  type Input = Parameters<typeof createProviderReviewRun>[0];
  const review = createProviderReviewRun({
    run: { runParams: { runId: "research-refusal" } } as Input["run"],
    runtime: {
      provider: "openai",
      modelId: "test-model",
      snapshot: () => ({ agentHarness: { id: "openclaw" }, effectiveModel: { api: "test-api" } }),
    } as Input["runtime"],
    session: {
      sessionId,
      sessionTarget: { agentId: "research", sessionKey, storePath: "/synthetic/research" },
    } as Input["session"],
    assertCurrent: () => {},
  });
  try {
    await review.settle({
      sessionIdUsed: sessionId,
      currentAttemptCompletedAssistant: makeAssistantMessageFixture({
        stopReason: "error",
        diagnostics: [
          { type: "provider_refusal", timestamp: 1, details: { category: "misalignment" } },
        ],
      }),
    } as EmbeddedRunAttemptResult);
  } finally {
    gate.resolve();
    await Promise.all(blockers);
    await settled;
  }
  expect(executed).toEqual(["main", "untagged main"]);
  expect((await settled).map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
    "fulfilled",
  ]);
});
