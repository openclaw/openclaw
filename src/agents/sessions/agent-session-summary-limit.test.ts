import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { applyAgentCompactionSettingsFromConfig } from "../agent-settings.js";
import { textStream } from "./agent-session-boundary.test-support.js";
import { agentSessionAutomaticCompaction } from "./agent-session-compaction.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import {
  createCompactionRequestBudget,
  estimateCompactedRequestTokens,
} from "./compaction/request-budget.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

async function history(model: Model) {
  const sessionManager = SessionManager.inMemory();
  await sessionManager.appendMessageAsync({
    role: "user",
    content: "Remember the project decisions.",
    timestamp: 1,
  });
  await sessionManager.appendMessageAsync(
    createAssistant(model, "The archive contains the project decisions."),
  );
  await sessionManager.appendMessageAsync({
    role: "user",
    content: "Continue the project.",
    timestamp: 3,
  });
  await sessionManager.appendMessageAsync(createAssistant(model, "Ready."));
  return sessionManager;
}

describe("configured compaction summary limit", () => {
  it.each([
    {
      name: "unchanged default",
      globalLimit: undefined,
      agentLimit: undefined,
      expectedLimit: 16_000,
    },
    { name: "global override", globalLimit: 48_000, agentLimit: undefined, expectedLimit: 48_000 },
    { name: "per-agent override", globalLimit: 48_000, agentLimit: 64_000, expectedLimit: 64_000 },
  ])("persists and replays the $name", async ({ globalLimit, agentLimit, expectedLimit }) => {
    const model = { ...testModel, contextWindow: 200_000 };
    const settingsManager = SettingsManager.inMemory({
      compaction: { keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    applyAgentCompactionSettingsFromConfig({
      settingsManager,
      agentId: "research",
      contextTokenBudget: model.contextWindow,
      cfg: {
        agents: {
          defaults: { compaction: { maxSummaryChars: globalLimit } },
          entries: { research: { compaction: { maxSummaryChars: agentLimit } } },
        },
      },
    });
    const sessionManager = await history(model);
    const { session } = await createTestSession({ model, settingsManager, sessionManager });
    const generated = "Decision: preserve this archived project constraint.\n".repeat(1_400);
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      textStream(activeModel, generated),
    );

    const result = await session.compact();
    expect(result.summary.length).toBe(expectedLimit);
    expect(
      sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
    ).toMatchObject({ summary: result.summary });
    expect(session.messages.find((message) => message.role === "compactionSummary")).toMatchObject({
      summary: result.summary,
    });
    expect(result.summary).toContain("[Compaction summary truncated to fit budget]");
  });

  it.each(["manual", "automatic"] as const)(
    "fits a raised %s summary to the active window",
    async (mode) => {
      const model = { ...testModel, contextWindow: 32_768, maxTokens: 8_192 };
      const settingsManager = SettingsManager.inMemory({
        compaction: { keepRecentTokens: 1 },
        retry: { enabled: false },
      });
      applyAgentCompactionSettingsFromConfig({
        settingsManager,
        contextTokenBudget: model.contextWindow,
        cfg: { agents: { defaults: { compaction: { maxSummaryChars: 64_000 } } } },
      });
      const sessionManager = await history(model);
      const { session } = await createTestSession({
        model,
        settingsManager,
        sessionManager,
        systemPrompt: "Keep the project requirements. ".repeat(200),
      });
      streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
        textStream(activeModel, "保留项目决策和归档要求。".repeat(4_000)),
      );
      const budget = createCompactionRequestBudget({
        contextWindow: model.contextWindow,
        reserveTokens: settingsManager.getCompactionReserveTokens(),
        systemPrompt: session.systemPrompt,
        tools: session.state.tools,
      });

      const outcome =
        mode === "manual"
          ? { status: "completed" as const, result: await session.compact() }
          : await session[agentSessionAutomaticCompaction](undefined, undefined, undefined, {
              requestBudget: budget,
            });
      if (outcome.status !== "completed") {
        throw new Error(outcome.reason);
      }
      expect(outcome.result.summary.length).toBeLessThan(40_000);
      expect(estimateCompactedRequestTokens(session.messages, budget)).toBeLessThanOrEqual(
        model.contextWindow - budget.reserveTokens,
      );
      expect(
        sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
      ).toMatchObject({ summary: outcome.result.summary });
    },
  );
  it.each(["manual", "automatic"] as const)(
    "does not turn a high fixed %s request into an over-window artifact",
    async (mode) => {
      const model = { ...testModel, contextWindow: 32_768, maxTokens: 8_192 };
      const settingsManager = SettingsManager.inMemory({
        compaction: { keepRecentTokens: 1 },
        retry: { enabled: false },
      });
      applyAgentCompactionSettingsFromConfig({
        settingsManager,
        contextTokenBudget: model.contextWindow,
        cfg: { agents: { defaults: { compaction: { maxSummaryChars: 64_000 } } } },
      });
      const sessionManager = SessionManager.inMemory();
      await sessionManager.appendMessageAsync({
        role: "user",
        content: "Old research material. ".repeat(5_000),
        timestamp: 1,
      });
      await sessionManager.appendMessageAsync(createAssistant(model, "Research processed."));
      await sessionManager.appendMessageAsync({ role: "user", content: "Continue.", timestamp: 3 });
      const { session } = await createTestSession({
        model,
        settingsManager,
        sessionManager,
        systemPrompt: "Required project instructions. ".repeat(3_000),
      });
      streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
        textStream(activeModel, "保留项目决策和归档要求。".repeat(4_000)),
      );
      const budget = createCompactionRequestBudget({
        contextWindow: model.contextWindow,
        reserveTokens: settingsManager.getCompactionReserveTokens(),
        systemPrompt: session.systemPrompt,
        tools: session.state.tools,
      });
      expect(budget.fixedTokens).toBeLessThan(model.contextWindow);
      expect(budget.fixedTokens + budget.reserveTokens).toBeGreaterThan(model.contextWindow);
      const outcome =
        mode === "manual"
          ? { status: "completed" as const, result: await session.compact() }
          : await session[agentSessionAutomaticCompaction](undefined, undefined, undefined, {
              requestBudget: budget,
            });
      expect(outcome.status).toBe("completed");
      expect(estimateCompactedRequestTokens(session.messages, budget)).toBeLessThanOrEqual(
        model.contextWindow,
      );
    },
  );
});
