import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { sanitizeSessionHistory } from "./google.js";

describe("sanitizeSessionHistory assistant error sanitization", () => {
  it("rewrites oversized raw API payload errors before replaying transcript", async () => {
    const sm = SessionManager.inMemory();
    const rawError =
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_abc"}';

    const messages: AgentMessage[] = [
      makeAssistantMessageFixture({
        stopReason: "error",
        errorMessage: rawError,
        content: [{ type: "text", text: rawError }],
      }) as unknown as AgentMessage,
    ];

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-codex-responses",
      provider: "openai",
      modelId: "gpt-5.3-codex",
      sessionManager: sm,
      sessionId: "test",
    });

    const assistant = sanitized[0] as AgentMessage & {
      errorMessage?: string;
      content?: Array<{ type?: string; text?: string }>;
    };

    expect(assistant.errorMessage).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(assistant.content?.[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
  });

  it("does not overwrite long non-error assistant text blocks", async () => {
    const sm = SessionManager.inMemory();
    const rawError =
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_abc"}';
    const partialLegitText = `partial:${"a".repeat(320)}`;

    const messages: AgentMessage[] = [
      makeAssistantMessageFixture({
        stopReason: "error",
        errorMessage: rawError,
        content: [{ type: "text", text: partialLegitText }],
      }) as unknown as AgentMessage,
    ];

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-codex-responses",
      provider: "openai",
      modelId: "gpt-5.3-codex",
      sessionManager: sm,
      sessionId: "test",
    });

    const assistant = sanitized[0] as AgentMessage & {
      errorMessage?: string;
      content?: Array<{ type?: string; text?: string }>;
    };

    expect(assistant.errorMessage).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(assistant.content?.[0]?.text).toBe(partialLegitText);
  });

  it("caps repeated suffix variants to keep transcript errors bounded", async () => {
    const sm = SessionManager.inMemory();
    const rawError = `boom:${"x".repeat(600)}`;

    const messages: AgentMessage[] = [
      makeAssistantMessageFixture({
        stopReason: "error",
        errorMessage: rawError,
      }) as unknown as AgentMessage,
      makeAssistantMessageFixture({
        stopReason: "error",
        errorMessage: rawError,
      }) as unknown as AgentMessage,
    ];

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-codex-responses",
      provider: "openai",
      modelId: "gpt-5.3-codex",
      sessionManager: sm,
      sessionId: "test",
    });

    const second = sanitized[1] as { errorMessage?: string };
    expect((second.errorMessage ?? "").length).toBeLessThanOrEqual(220);
    expect(second.errorMessage).toContain("(repeated x2)");
  });

  it("marks repeated consecutive assistant errors with a compact counter", async () => {
    const sm = SessionManager.inMemory();
    const rawError =
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_abc"}';

    const messages: AgentMessage[] = [
      makeAssistantMessageFixture({
        stopReason: "error",
        errorMessage: rawError,
      }) as unknown as AgentMessage,
      makeAssistantMessageFixture({
        stopReason: "error",
        errorMessage: rawError,
      }) as unknown as AgentMessage,
    ];

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-codex-responses",
      provider: "openai",
      modelId: "gpt-5.3-codex",
      sessionManager: sm,
      sessionId: "test",
    });

    const first = sanitized[0] as { errorMessage?: string };
    const second = sanitized[1] as { errorMessage?: string };

    expect(first.errorMessage).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(second.errorMessage).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment. (repeated x2)",
    );
  });
});
