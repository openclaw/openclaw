import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { agentSessionAutomaticCompaction } from "./agent-session-compaction.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createCompactionRequestBudget } from "./compaction/request-budget.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

it.each([
  { name: "fitting", rows: 10, pendingRows: 0, historyRows: 1, blocked: false },
  { name: "reserve-only pressure", rows: 300, pendingRows: 0, historyRows: 1, blocked: false },
  { name: "fixed-context overflow", rows: 1_000, pendingRows: 0, historyRows: 1, blocked: true },
  { name: "pending-input overflow", rows: 10, pendingRows: 1_000, historyRows: 1, blocked: true },
  {
    name: "retained-history overflow",
    rows: 10,
    pendingRows: 0,
    historyRows: 1_000,
    blocked: true,
  },
])(
  "checks $name after a safeguard no-op",
  async ({ rows, pendingRows, historyRows, blocked, name }) => {
    const model = { ...testModel, contextWindow: 4_096, maxTokens: 256 };
    const sessionManager = SessionManager.inMemory();
    const keptId = await sessionManager.appendMessageAsync(
      makeUserMessage("Retain the blue project. ".repeat(historyRows), 1),
    );
    if (!keptId) {
      throw new Error("Expected the retained user entry");
    }
    await sessionManager.appendCompactionAsync(
      "Earlier project work is complete.",
      keptId,
      5_000,
      undefined,
      true,
    );
    const { session } = await createTestSession({
      model,
      sessionManager,
      systemPrompt: "Preserve these fixed project instructions. ".repeat(rows),
    });
    const requestBudget = createCompactionRequestBudget({
      contextWindow: model.contextWindow,
      reserveTokens: 1_024,
      systemPrompt: session.systemPrompt,
      pendingPrompt: "Confirm the project color. " + "Pending input. ".repeat(pendingRows),
    });
    const before = structuredClone(sessionManager.getBranch());
    if (name === "reserve-only pressure") {
      expect(requestBudget.fixedTokens + requestBudget.pendingTokens).toBeGreaterThan(
        model.contextWindow - requestBudget.reserveTokens,
      );
      expect(requestBudget.fixedTokens + requestBudget.pendingTokens).toBeLessThan(
        model.contextWindow,
      );
    }
    const outcome = session[agentSessionAutomaticCompaction](undefined, "unresolved", undefined, {
      requestBudget,
    });
    if (blocked) {
      await expect(outcome).rejects.toThrow("foreground");
    } else {
      await expect(outcome).resolves.toMatchObject({ status: "skipped" });
    }
    expect(sessionManager.getBranch()).toEqual(before);
    expect(streamMocks.streamSimple).not.toHaveBeenCalled();
  },
);
