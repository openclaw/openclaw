import { expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { createAttemptCompactionThinkingResolver } from "../embedded-agent-runner/run/attempt-compaction-thinking.js";
import { textStream } from "./agent-session-boundary.test-support.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

function resolver(thinkingLevel?: "low" | "inherit" | "adaptive" | "ultra") {
  const compaction = { thinkingLevel };
  const config = thinkingLevel ? { agents: { defaults: { compaction } } } : undefined;
  return createAttemptCompactionThinkingResolver({ config }, "main");
}

it.each([
  [undefined, undefined, "low"],
  [undefined, "off", "off"],
  ["low", "off", "low"],
  ["inherit", undefined, "high"],
  ["adaptive", undefined, "medium"],
  ["ultra", undefined, "high"],
] as const)(
  "applies compaction thinking %s with provider default %s as %s",
  async (configured, providerDefault, expected) => {
    const model = {
      ...testModel,
      reasoning: true,
      contextWindow: 4_096,
      maxTokens: 512,
      ...(providerDefault ? { compactionThinkingDefault: providerDefault } : {}),
    };
    const sessionManager = SessionManager.inMemory();
    for (const [index, turn] of ["old", "latest"].entries()) {
      const timestamp = index * 2 + 1;
      sessionManager.appendMessage({ role: "user", content: `${turn} prompt`, timestamp });
      sessionManager.appendMessage({
        ...createAssistant(model, `${turn} answer`),
        timestamp: timestamp + 1,
      });
    }
    const reasoning: Array<string | undefined> = [];
    streamMocks.streamSimple.mockImplementation((activeModel, _context, options) => {
      reasoning.push(options?.reasoning);
      const first = reasoning.length === 1;
      return textStream(activeModel, first ? "reply" : "summary", "stop", first ? 3_900 : 30);
    });
    const { session } = await createTestSession({
      model,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        defaultThinkingLevel: "high",
        compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1 },
        retry: { enabled: false },
      }),
      resolveCompactionThinkingLevel: resolver(configured),
    });
    const ends: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        ends.push(event);
      }
    });

    await session.prompt("trigger threshold");

    expect(ends).toMatchObject([{ reason: "threshold", outcome: { status: "completed" } }]);
    expect(reasoning).toEqual(["high", expected, expected]);
  },
);

it.each([
  { provider: "anthropic", id: "claude-sonnet-4-6" },
  {
    provider: "claude-gateway",
    id: "team-sonnet",
    params: { canonicalModelId: "claude-sonnet-4-6" },
  },
])("runs adaptive summaries at high effort for $provider/$id", (model) => {
  const candidate: Model = { ...testModel, ...model, api: "anthropic-messages", reasoning: true };
  expect(resolver("adaptive")(candidate, "low")).toBe("high");
});
