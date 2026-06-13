import { describe, expect, it } from "vitest";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./result-fallback-classifier.js";

describe("classifyEmbeddedAgentRunResultForModelFallback", () => {
  it("does not fallback when sessions_spawn accepted a child session", () => {
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

  it("does not fallback after cron side-effect progress without a visible payload", () => {
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "xai",
        model: "grok-composer-2.5-fast",
        result: {
          meta: { durationMs: 1 },
          successfulCronAdds: 1,
        },
      }),
    ).toBeNull();
  });

  it("does not fallback after message-tool side-effect progress without visible delivery", () => {
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "xai",
        model: "grok-composer-2.5-fast",
        result: {
          meta: { durationMs: 1 },
          didSendViaMessagingTool: true,
        },
      }),
    ).toBeNull();
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "xai",
        model: "grok-composer-2.5-fast",
        result: {
          meta: { durationMs: 1 },
          messagingToolSentTargets: [{ tool: "message", provider: "discord", to: "channel-1" }],
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

  it("classifies unclassified non-GPT empty terminal results", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "xai",
      model: "grok-composer-2.5-fast",
      result: {
        payloads: [],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toMatchObject({
      reason: "format",
      code: "empty_result",
    });
  });

  it("classifies empty terminal results after replay-safe completed tool activity", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "xai",
      model: "grok-composer-2.5-fast",
      result: {
        payloads: [],
        meta: {
          durationMs: 42,
          replayInvalid: false,
          toolSummary: {
            tools: ["status_probe"],
            calls: 1,
            hadFailure: false,
          },
        },
      },
    });

    expect(result).toMatchObject({
      reason: "format",
      code: "empty_result",
    });
  });

  it("does not classify incomplete terminal results when replay safety is missing", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "xai",
      model: "grok-composer-2.5-fast",
      result: {
        payloads: [
          {
            isError: true,
            text: "⚠️ Agent couldn't generate a response. Please try again.",
          },
        ],
        meta: {
          durationMs: 42,
          toolSummary: {
            tools: ["status_probe"],
            calls: 1,
            hadFailure: false,
          },
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not classify incomplete terminal results after replay-invalid completed tool activity", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "xai",
      model: "grok-composer-2.5-fast",
      result: {
        payloads: [
          {
            isError: true,
            text: "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.",
          },
        ],
        meta: {
          durationMs: 42,
          replayInvalid: true,
          toolSummary: {
            tools: ["write"],
            calls: 1,
            hadFailure: false,
          },
        },
      },
    });

    expect(result).toBeNull();
  });

  it.each(["empty", "reasoning-only", "planning-only"] as const)(
    "does not classify %s harness results after replay-invalid tool activity",
    (agentHarnessResultClassification) => {
      const result = classifyEmbeddedAgentRunResultForModelFallback({
        provider: "xai",
        model: "grok-composer-2.5-fast",
        result: {
          payloads: [],
          meta: {
            durationMs: 42,
            replayInvalid: true,
            agentHarnessResultClassification,
            toolSummary: {
              tools: ["write"],
              calls: 1,
              hadFailure: false,
            },
          },
        },
      });

      expect(result).toBeNull();
    },
  );

  it("classifies unclassified non-GPT reasoning-only terminal results", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "xai",
      model: "grok-composer-2.5-fast",
      result: {
        payloads: [
          {
            isReasoning: true,
            text: "thinking only",
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toMatchObject({
      reason: "format",
      code: "reasoning_only_result",
    });
  });

  it("does not let block replies suppress planning-only harness classifications", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "xai",
      model: "grok-composer-2.5-fast",
      hasDirectlySentBlockReply: true,
      hasBlockReplyPipelineOutput: true,
      result: {
        payloads: [],
        meta: {
          durationMs: 42,
          agentHarnessResultClassification: "planning-only",
        },
      },
    });

    expect(result).toMatchObject({
      reason: "format",
      code: "planning_only_result",
    });
  });

  it("lets delivered block replies suppress empty harness classifications", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "xai",
      model: "grok-composer-2.5-fast",
      hasDirectlySentBlockReply: true,
      result: {
        payloads: [],
        meta: {
          durationMs: 42,
          agentHarnessResultClassification: "empty",
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
});
