// Coverage for deciding when embedded run results should trigger model fallback.
import { describe, expect, it } from "vitest";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../auto-reply/reply/agent-runner-failure-copy.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./result-fallback-classifier.js";

describe("classifyEmbeddedAgentRunResultForModelFallback", () => {
  it("does not fallback when sessions_spawn accepted a child session", () => {
    // Accepted child sessions mean the turn made progress even if the parent did
    // not emit a normal assistant reply.
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "mock-openai",
        model: "gpt-5.5",
        result: {
          meta: { durationMs: 1 },
          acceptedSessionSpawns: [
            {
              runId: "run-child",
              childSessionKey: "agent:qa:subagent:child",
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it("classifies provider business-denial error payloads as fallback-worthy", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "zai",
      model: "glm-5.1",
      result: {
        payloads: [
          {
            isError: true,
            text: '{"success":false,"code":"CE-011","message":"当前ak因违规请求被禁止访问该模型"}',
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toEqual({
      message:
        'zai/glm-5.1 ended with a provider error: {"success":false,"code":"CE-011","message":"当前ak因违规请求被禁止访问该模型"}',
      reason: "auth",
      code: "embedded_error_payload",
      rawError: '{"success":false,"code":"CE-011","message":"当前ak因违规请求被禁止访问该模型"}',
    });
  });

  it("preserves hook block results with auth-like error payload text", () => {
    // Hook policy blocks are intentional local decisions, not provider failures
    // that should rotate models.
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "custom",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            isError: true,
            text: "Access denied by policy",
          },
        ],
        meta: {
          durationMs: 42,
          error: {
            kind: "hook_block",
            message: "Access denied by policy",
          },
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not fallback on deliberate silent terminal replies after payload filtering", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [],
        meta: {
          durationMs: 42,
          finalAssistantRawText: "NO_REPLY",
          finalAssistantVisibleText: "NO_REPLY",
        },
      },
    });

    expect(result).toBeNull();
  });

  it("uses provider-scoped failover matching for business-denial payloads", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openrouter",
      model: "claude-3.5-sonnet",
      result: {
        payloads: [
          {
            isError: true,
            text: "Key limit exceeded",
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toEqual({
      message: "openrouter/claude-3.5-sonnet ended with a provider error: Key limit exceeded",
      reason: "billing",
      code: "embedded_error_payload",
      rawError: "Key limit exceeded",
    });
  });

  it("does not retry unclassified non-GPT error payloads", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "custom",
      model: "llama-3.1",
      result: {
        payloads: [
          {
            isError: true,
            text: "the model produced an application-level error",
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not retry non-business transport error payloads", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "custom",
      model: "llama-3.1",
      result: {
        payloads: [
          {
            isError: true,
            text: "HTTP 500: internal server error",
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toBeNull();
  });

  it("keeps tool-authored incomplete summaries fallback-eligible", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            isError: true,
            text:
              "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
              "⚠️ Agent couldn't generate a response. Please try again.",
          },
        ],
        meta: {
          durationMs: 42,
          replayInvalid: true,
          agentHarnessResultClassification: "empty",
          toolSummary: {
            calls: 1,
          },
          error: {
            kind: "incomplete_turn",
            message: "Agent couldn't generate a response.",
            fallbackSafe: true,
            terminalPresentation: true,
          },
        },
      },
    });

    expect(result).toEqual({
      message:
        "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
        "⚠️ Agent couldn't generate a response. Please try again.",
      reason: "format",
      code: "incomplete_result",
      preserveResultOnExhaustion: true,
      preserveResultPriority: 1,
    });
  });

  it("does not fallback after structured replay state records potential side effects", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [],
        meta: {
          durationMs: 42,
          replayInvalid: true,
          agentHarnessResultClassification: "reasoning-only",
        },
      },
    });

    expect(result).toBeNull();
  });

  it("keeps side-effecting incomplete tool turns out of fallback before harness classification", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [{ isError: true, text: "Agent couldn't generate a response." }],
        meta: {
          durationMs: 42,
          agentHarnessResultClassification: "empty",
          toolSummary: {
            calls: 1,
          },
          error: {
            kind: "incomplete_turn",
            message: "Agent couldn't generate a response.",
            fallbackSafe: false,
          },
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not trust fallback-safe metadata over concrete outbound delivery evidence", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [{ isError: true, text: "Agent couldn't generate a response." }],
        messagingToolSentTexts: ["already delivered"],
        meta: {
          durationMs: 42,
          error: {
            kind: "incomplete_turn",
            message: "Agent couldn't generate a response.",
            fallbackSafe: true,
          },
        },
      },
    });

    expect(result).toBeNull();
  });

  it("triggers fallback when the only visible payload is the generic external run failure text", () => {
    // Some subprocess runners (e.g. claude-cli) deliver their error text as a
    // regular text payload (isError: false). The classifier should treat this
    // as invisible and allow fallback to the next provider in the chain.
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
          },
        ],
        meta: { durationMs: 42 },
      },
    });

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      code: "empty_result",
      reason: "format",
    });
  });

  it("does not trigger fallback when generic failure text is mixed with normal payloads", () => {
    // If there is real visible text alongside the generic failure text, the
    // run made progress and should not trigger model fallback.
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [
          { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT },
          { text: "Actual assistant response content" },
        ],
        meta: { durationMs: 42 },
      },
    });

    expect(result).toBeNull();
  });

  it("does not suppress business-denial error payload classification when generic failure text is present", () => {
    // The pre-check only strips the generic failure text from visible-content
    // consideration; if a business-denial error payload also exists, it must
    // still be classified by the existing error-payload path.
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openrouter",
      model: "gpt-5.5",
      result: {
        payloads: [
          { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT },
          { isError: true, text: "Key limit exceeded" },
        ],
        meta: { durationMs: 42 },
      },
    });

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      code: "embedded_error_payload",
      reason: "billing",
    });
  });
});
