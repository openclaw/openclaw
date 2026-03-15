import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { formatAssistantErrorForTranscript } from "../pi-embedded-helpers.js";
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

  it("rewrites string-shaped assistant content when it still contains a raw error payload", async () => {
    const sm = SessionManager.inMemory();
    const rawError =
      '500 {"type":"error","error":{"type":"server_error","message":"Oops"},"request_id":"req_abc"}';
    const malformedAssistant = makeAssistantMessageFixture({
      stopReason: "error",
      errorMessage: rawError,
    }) as unknown as AgentMessage & { content?: unknown };
    malformedAssistant.content = rawError;

    const sanitized = await sanitizeSessionHistory({
      messages: [malformedAssistant],
      modelApi: "openai-codex-responses",
      provider: "openai",
      modelId: "gpt-5.3-codex",
      sessionManager: sm,
      sessionId: "test",
    });

    const assistant = sanitized[0] as AgentMessage & {
      errorMessage?: string;
      content?: string;
    };

    const normalized = formatAssistantErrorForTranscript(rawError);
    expect(assistant.errorMessage).toBe(normalized);
    expect(assistant.content).toBe(normalized);
  });

  it("does not overwrite string-shaped legitimate partial assistant content", async () => {
    const sm = SessionManager.inMemory();
    const rawError =
      '500 {"type":"error","error":{"type":"server_error","message":"Oops"},"request_id":"req_abc"}';
    const partialLegitText = `partial:${"b".repeat(320)}`;
    const malformedAssistant = makeAssistantMessageFixture({
      stopReason: "error",
      errorMessage: rawError,
    }) as unknown as AgentMessage & { content?: unknown };
    malformedAssistant.content = partialLegitText;

    const sanitized = await sanitizeSessionHistory({
      messages: [malformedAssistant],
      modelApi: "openai-codex-responses",
      provider: "openai",
      modelId: "gpt-5.3-codex",
      sessionManager: sm,
      sessionId: "test",
    });

    const assistant = sanitized[0] as AgentMessage & {
      errorMessage?: string;
      content?: string;
    };

    expect(assistant.errorMessage).toBe(formatAssistantErrorForTranscript(rawError));
    expect(assistant.content).toBe(partialLegitText);
  });

  it("rewrites pretty-printed payload blocks even when the compact raw error string differs", async () => {
    const sm = SessionManager.inMemory();
    const rawError =
      '500 {"type":"error","error":{"type":"server_error","message":"Oops"},"request_id":"req_abc"}';
    const prettyPrinted = `500 {\n  "type": "error",\n  "error": {\n    "type": "server_error",\n    "message": "Oops"\n  },\n  "request_id": "req_abc"\n}`;

    const messages: AgentMessage[] = [
      makeAssistantMessageFixture({
        stopReason: "error",
        errorMessage: rawError,
        content: [{ type: "text", text: prettyPrinted }],
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
      content?: Array<{ type?: string; text?: string }>;
    };

    expect(assistant.content?.[0]?.text).toBe(formatAssistantErrorForTranscript(rawError));
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

  it("continues counting repeated errors across later replay passes", async () => {
    const sm = SessionManager.inMemory();
    const rawError =
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_abc"}';

    const firstPass = await sanitizeSessionHistory({
      messages: [
        makeAssistantMessageFixture({
          stopReason: "error",
          errorMessage: rawError,
        }) as unknown as AgentMessage,
        makeAssistantMessageFixture({
          stopReason: "error",
          errorMessage: rawError,
        }) as unknown as AgentMessage,
      ],
      modelApi: "openai-codex-responses",
      provider: "openai",
      modelId: "gpt-5.3-codex",
      sessionManager: sm,
      sessionId: "test",
    });

    const secondPass = await sanitizeSessionHistory({
      messages: [
        ...firstPass,
        makeAssistantMessageFixture({
          stopReason: "error",
          errorMessage: rawError,
        }) as unknown as AgentMessage,
      ],
      modelApi: "openai-codex-responses",
      provider: "openai",
      modelId: "gpt-5.3-codex",
      sessionManager: sm,
      sessionId: "test",
    });

    const third = secondPass[2] as { errorMessage?: string };
    expect(third.errorMessage).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment. (repeated x3)",
    );
  });
});
