import type { Context, Model, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createAttemptCompactionThinkingResolver } from "../embedded-agent-runner/run/attempt-compaction-thinking.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession threshold compaction thinking", () => {
  it.each([
    { configured: undefined, providerDefault: undefined, expected: "low" },
    { configured: undefined, providerDefault: "off", expected: "off" },
    { configured: "low", providerDefault: "off", expected: "low" },
    { configured: "inherit", providerDefault: undefined, expected: "high" },
    { configured: "adaptive", providerDefault: undefined, expected: "medium" },
    { configured: "ultra", providerDefault: undefined, expected: "high" },
  ] as const)(
    "applies $configured compaction thinking with provider default $providerDefault to threshold summaries",
    async ({ configured, providerDefault, expected }) => {
      const model = {
        ...testModel,
        reasoning: true,
        contextWindow: 4_096,
        maxTokens: 512,
        ...(providerDefault ? { compactionThinkingDefault: providerDefault } : {}),
      };
      const sessionManager = SessionManager.inMemory();
      sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
      sessionManager.appendMessage({
        ...createAssistant(model, [{ type: "text", text: "old answer" }]),
        timestamp: 2,
      });
      sessionManager.appendMessage({ role: "user", content: "latest prompt", timestamp: 3 });
      sessionManager.appendMessage({
        ...createAssistant(model, [{ type: "text", text: "latest answer" }]),
        timestamp: 4,
      });
      const reasoning: Array<string | undefined> = [];
      streamMocks.streamSimple.mockImplementation(
        (activeModel: Model, _context: Context, options?: SimpleStreamOptions) => {
          reasoning.push(options?.reasoning);
          return createAssistantResultStream(
            createAssistant(
              activeModel,
              [{ type: "text", text: reasoning.length === 1 ? "reply" : "summary" }],
              "stop",
              reasoning.length === 1 ? 3_900 : 30,
            ),
          );
        },
      );
      const { session } = await createTestSession({
        model,
        sessionManager,
        settingsManager: SettingsManager.inMemory({
          defaultThinkingLevel: "high",
          compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1 },
          retry: { enabled: false },
        }),
        resolveCompactionThinkingLevel: createAttemptCompactionThinkingResolver(
          {
            config: configured
              ? { agents: { defaults: { compaction: { thinkingLevel: configured } } } }
              : undefined,
            sessionKey: undefined,
            sandboxSessionKey: undefined,
          },
          "main",
        ),
      });
      const ends: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
      session.subscribe((event) => {
        if (event.type === "compaction_end") {
          ends.push(event);
        }
      });

      await session.prompt("trigger threshold");

      expect(ends).toMatchObject([{ reason: "threshold", outcome: { status: "completed" } }]);
      expect(reasoning[0]).toBe("high");
      expect(reasoning.slice(1)).toEqual([expected, expected]);
    },
  );

  it("runs adaptive summaries at the chat turn's high effort on adaptive-capable models", () => {
    const resolveCompactionThinkingLevel = createAttemptCompactionThinkingResolver(
      {
        config: { agents: { defaults: { compaction: { thinkingLevel: "adaptive" } } } },
        sessionKey: undefined,
        sandboxSessionKey: undefined,
      },
      "main",
    );
    const claude = {
      ...testModel,
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      api: "anthropic-messages" as const,
      reasoning: true,
    };

    expect(resolveCompactionThinkingLevel(claude, "low")).toBe("high");
  });

  it("resolves summaries against a Claude deployment alias's backing model", () => {
    const resolveCompactionThinkingLevel = createAttemptCompactionThinkingResolver(
      {
        config: { agents: { defaults: { compaction: { thinkingLevel: "adaptive" } } } },
        sessionKey: undefined,
        sandboxSessionKey: undefined,
      },
      "main",
    );
    const deployment = {
      ...testModel,
      provider: "claude-gateway",
      id: "team-sonnet",
      api: "anthropic-messages" as const,
      reasoning: true,
      params: { canonicalModelId: "claude-sonnet-4-6" },
    };

    expect(resolveCompactionThinkingLevel(deployment, "low")).toBe("high");
  });
});
