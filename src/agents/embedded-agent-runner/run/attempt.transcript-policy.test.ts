// Coverage for resolving transcript replay policy for embedded attempts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import {
  resolveAttemptTranscriptPolicy,
  shouldForceToolCallIdSanitization,
  shouldRetryWithForcedToolCallIdSanitization,
} from "./attempt.transcript-policy.js";

const resolveProviderRuntimePluginMock = vi.hoisted(() => vi.fn());

vi.mock("../../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: resolveProviderRuntimePluginMock,
}));

describe("resolveAttemptTranscriptPolicy", () => {
  beforeEach(() => {
    resolveProviderRuntimePluginMock.mockReset();
    resolveProviderRuntimePluginMock.mockReturnValue(undefined);
  });

  it("uses RuntimePlan transcript policy when available", () => {
    // RuntimePlan owns provider/plugin transcript policy; legacy fallbacks only
    // run when a plan is unavailable.
    const plannedPolicy = {
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: false,
      repairToolUseResultPairing: true,
      preserveSignatures: true,
      dropThinkingBlocks: true,
      applyGoogleTurnOrdering: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    } as const;
    const resolvePolicy = vi.fn(() => plannedPolicy);
    const runtimePlan = {
      transcript: {
        resolvePolicy,
      },
    } as unknown as AgentRuntimePlan;
    const runtimePlanModelContext = {
      workspaceDir: "/tmp/openclaw-transcript-policy",
      modelApi: "anthropic-messages",
      model: {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      } satisfies ProviderRuntimeModel,
    };

    expect(
      resolveAttemptTranscriptPolicy({
        runtimePlan,
        runtimePlanModelContext,
        provider: "anthropic",
        modelId: "claude-opus-4.6",
      }),
    ).toBe(plannedPolicy);
    expect(resolvePolicy).toHaveBeenCalledWith(runtimePlanModelContext);
  });

  it("forces strict tool call id sanitization after a provider format retry", () => {
    const plannedPolicy = {
      sanitizeMode: "images-only",
      sanitizeToolCallIds: false,
      toolCallIdMode: "strict9",
      preserveNativeAnthropicToolUseIds: false,
      repairToolUseResultPairing: true,
      preserveSignatures: false,
      dropThinkingBlocks: false,
      applyGoogleTurnOrdering: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      allowSyntheticToolResults: false,
    } as const;
    const runtimePlan = {
      transcript: {
        resolvePolicy: vi.fn(() => plannedPolicy),
      },
    } as unknown as AgentRuntimePlan;

    const policy = resolveAttemptTranscriptPolicy({
      runtimePlan,
      runtimePlanModelContext: {
        workspaceDir: ".",
        modelApi: "anthropic-messages",
      },
      provider: "github-copilot",
      modelId: "claude-sonnet-4",
      forceToolCallIdSanitization: true,
    });

    expect(policy).toEqual({
      ...plannedPolicy,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });
  });

  it("allows exactly one forced sanitization retry for a provider format error", () => {
    expect(
      shouldRetryWithForcedToolCallIdSanitization({
        cloudCodeAssistFormatError: true,
        errorMessage: "messages.17.content.0.tool_use.id: String should match pattern",
        modelApi: "anthropic-messages",
      }),
    ).toBe(true);
    expect(
      shouldRetryWithForcedToolCallIdSanitization({
        cloudCodeAssistFormatError: true,
        errorMessage: "tool call id was invalid and must match the required pattern",
        modelApi: "anthropic-messages",
      }),
    ).toBe(true);
    expect(
      shouldRetryWithForcedToolCallIdSanitization({
        cloudCodeAssistFormatError: true,
        errorMessage: "messages.17.content.0.tool_use.id: String should match pattern",
        forceToolCallIdSanitizationApi: "anthropic-messages",
        modelApi: "anthropic-messages",
      }),
    ).toBe(false);
    expect(
      shouldRetryWithForcedToolCallIdSanitization({
        cloudCodeAssistFormatError: true,
        errorMessage: "invalid request format",
        modelApi: "anthropic-messages",
      }),
    ).toBe(false);
    expect(
      shouldRetryWithForcedToolCallIdSanitization({
        cloudCodeAssistFormatError: true,
        errorMessage: "messages.17.content.0.tool_use.id: String should match pattern",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
    expect(
      shouldRetryWithForcedToolCallIdSanitization({
        cloudCodeAssistFormatError: true,
        errorMessage: "messages.17.content.0.tool_use.id: String should match pattern",
        forceToolCallIdSanitizationApi: "anthropic-messages",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("limits forced sanitization to the API that rejected the transcript", () => {
    expect(
      shouldForceToolCallIdSanitization({
        forceToolCallIdSanitizationApi: "anthropic-messages",
        modelApi: "anthropic-messages",
      }),
    ).toBe(true);
    expect(
      shouldForceToolCallIdSanitization({
        forceToolCallIdSanitizationApi: "anthropic-messages",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("keeps the legacy provider transcript fallback when no RuntimePlan is available", () => {
    // Legacy fallback remains for older runner paths and tests provider runtime
    // plugin discovery with the same workspace/env context.
    const env = { OPENCLAW_TEST_TRANSCRIPT_POLICY: "1" } as NodeJS.ProcessEnv;
    const policy = resolveAttemptTranscriptPolicy({
      runtimePlanModelContext: {
        workspaceDir: "/tmp/openclaw-transcript-policy",
        modelApi: "openai-responses",
      },
      provider: "custom-openai-compatible",
      modelId: "gpt-5.4",
      env,
    });

    expect(policy.sanitizeMode).toBe("images-only");
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
    expect(policy.repairToolUseResultPairing).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(false);
    expect(policy.allowSyntheticToolResults).toBe(true);
    expect(resolveProviderRuntimePluginMock).toHaveBeenCalledWith({
      provider: "custom-openai-compatible",
      modelId: "gpt-5.4",
      config: undefined,
      workspaceDir: "/tmp/openclaw-transcript-policy",
      env,
    });
  });

  it("inherits Claude-family OpenAI Responses turn validation from legacy fallback", () => {
    const policy = resolveAttemptTranscriptPolicy({
      runtimePlanModelContext: {
        workspaceDir: "/tmp/openclaw-transcript-policy",
        modelApi: "openai-responses",
      },
      provider: "anthropic-foundry",
      modelId: "anthropic-foundry/claude-opus-4-7",
    });

    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
    expect(policy.validateAnthropicTurns).toBe(true);
    expect(policy.validateGeminiTurns).toBe(false);
  });
});
