import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { sanitizeSessionHistory } from "./replay-history.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  // mock-isolation: Replay sanitization precedes provider-specific behavior.
  resolveProviderRuntimePlugin: () => undefined,
  sanitizeProviderReplayHistoryWithPluginAsync: () => undefined,
  validateProviderReplayTurnsWithPlugin: () => undefined,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
}));

function replay(
  messages: AgentMessage[],
  overrides: Partial<Parameters<typeof sanitizeSessionHistory>[0]> = {},
) {
  return sanitizeSessionHistory({
    messages,
    modelApi: "anthropic-messages",
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    sessionManager: SessionManager.inMemory(),
    sessionId: "test",
    ...overrides,
  });
}

describe("sanitizeSessionHistory", () => {
  it("preserves multiple signed Haiku 5.5 turns after an appended context update", async () => {
    const modelId = "claude-haiku-5-5";
    const messages: AgentMessage[] = [makeUserMessage("first", 0)];
    for (const timestamp of [1, 3]) {
      messages.push(
        makeAgentAssistantMessage({
          api: "anthropic-messages",
          provider: "anthropic",
          model: modelId,
          timestamp,
          content: [
            {
              type: "thinking",
              thinking: "reasoning",
              thinkingSignature: `synthetic-${timestamp}`,
            },
            { type: "text", text: "answer" },
          ],
        }),
        makeUserMessage(
          timestamp === 1 ? "second" : "[Runtime context update] Continue.",
          timestamp + 1,
        ),
      );
    }
    expect(await replay(messages, { modelId, sessionId: "haiku-signed-replay" })).toEqual(messages);
  });
});
