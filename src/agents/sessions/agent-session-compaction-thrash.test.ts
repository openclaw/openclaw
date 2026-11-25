import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import {
  fitCompactionSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
} from "../../../packages/agent-core/src/harness/compaction/compaction-summary-budget.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

function inputTokens(context: Context) {
  return Math.ceil(
    JSON.stringify({
      system: context.systemPrompt,
      tools: context.tools ?? [],
      messages: context.messages.map(({ role, content }) => ({ role, content })),
    }).length / 4,
  );
}

it.each([
  { window: 8_192, reserve: 2_048, fullSummary: false },
  { window: 200_000, reserve: 16_384, fullSummary: true },
])(
  "does not compact on the turn after a compaction in a $window-token window",
  async ({ window, reserve, fullSummary }) => {
    const model = { ...testModel, contextWindow: window, maxTokens: 512 };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: reserve, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const sessionManager = SessionManager.inMemory();
    const { session } = await createTestSession({
      model,
      settingsManager,
      sessionManager,
      systemPrompt: "Follow the project rules. ".repeat(160),
    });
    const compactionsPerTurn: number[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      const tokens = inputTokens(context);
      // The summarizer writes up to the persisted summary ceiling.
      const text = session.isCompacting ? "Summary detail. ".repeat(1_000) : "ACK";
      const response = createAssistant(activeModel, [{ type: "text", text }], "stop", tokens);
      response.usage.output = Math.ceil(text.length / 4);
      response.usage.totalTokens = tokens + response.usage.output;
      response.usage.contextUsage = {
        state: "available",
        promptTokens: tokens,
        totalTokens: response.usage.totalTokens,
      };
      return createAssistantResultStream(response);
    });
    const turn = Math.floor(window / 6);
    for (let index = 0; index < 6; index += 1) {
      const before = sessionManager.getEntries().filter((entry) => entry.type === "compaction");
      await session.prompt(`Turn ${index}. ${"Project facts. ".repeat(Math.floor(turn / 4))}`);
      const after = sessionManager.getEntries().filter((entry) => entry.type === "compaction");
      compactionsPerTurn.push(after.length - before.length);
    }
    const summaries = sessionManager
      .getEntries()
      .flatMap((entry) => (entry.type === "compaction" ? [entry.summary.length] : []));
    expect(summaries.length).toBeGreaterThan(0);
    // The summary must leave room for the next turn: no turn compacts right after another.
    expect(
      compactionsPerTurn.some((count, index) => count > 0 && compactionsPerTurn[index - 1]),
    ).toBe(false);
    // A window with room keeps the full summary ceiling.
    expect(summaries.every((chars) => chars >= MAX_COMPACTION_SUMMARY_CHARS)).toBe(fullSummary);
  },
);

it("uses the whole budget when the required summary parts cannot fit in half", () => {
  const required = "Required request context. ".repeat(20);
  const fitted = fitCompactionSummary(200, (maxChars) =>
    maxChars < required.length
      ? undefined
      : { summary: `${required}${"detail ".repeat(200)}`.slice(0, maxChars) },
  );
  expect(fitted.ok && fitted.value.summary.startsWith(required)).toBe(true);
});
