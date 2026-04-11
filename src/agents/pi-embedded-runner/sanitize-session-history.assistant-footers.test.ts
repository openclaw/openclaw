import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../test-helpers/agent-message-fixtures.js";
import { sanitizeSessionHistory } from "./replay-history.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
  sanitizeProviderReplayHistoryWithPlugin: () => undefined,
  validateProviderReplayTurnsWithPlugin: () => undefined,
}));

describe("sanitizeSessionHistory assistant footer stripping", () => {
  it("removes stale provider/model attribution from assistant replay text blocks", async () => {
    const sm = SessionManager.inMemory();

    const messages: AgentMessage[] = [
      makeAgentUserMessage({
        content: "hello",
        timestamp: 1,
      }) as unknown as AgentMessage,
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Hey Ted — what's up?\n\n— openai/gpt-4o" }],
        provider: "zai",
        model: "glm-5-turbo",
        api: "openai-completions",
        timestamp: 2,
      }) as unknown as AgentMessage,
    ];

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-completions",
      provider: "zai",
      modelId: "glm-5-turbo",
      sessionManager: sm,
      sessionId: "test",
    });

    const assistant = sanitized[1] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "Hey Ted — what's up?" }]);
    expect(JSON.stringify(sanitized)).not.toContain("openai/gpt-4o");
  });

  it("preserves the assistant turn when a footer-only message sanitizes to empty", async () => {
    const sm = SessionManager.inMemory();

    const messages: AgentMessage[] = [
      makeAgentUserMessage({
        content: "hello",
        timestamp: 1,
      }) as unknown as AgentMessage,
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "— openai/gpt-4o" }],
        provider: "zai",
        model: "glm-5-turbo",
        api: "openai-completions",
        timestamp: 2,
      }) as unknown as AgentMessage,
    ];

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-completions",
      provider: "zai",
      modelId: "glm-5-turbo",
      sessionManager: sm,
      sessionId: "test",
    });

    const assistant = sanitized[1] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "" }]);
  });
});
