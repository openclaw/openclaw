import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import { resolveAttemptTranscriptPolicy } from "./attempt.transcript-policy.js";

describe("resolveAttemptTranscriptPolicy", () => {
  it("uses RuntimePlan transcript policy when available", () => {
    const plannedPolicy = {
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: false,
      repairToolUseResultPairing: true,
      preserveSignatures: true,
      sanitizeThinkingSignatures: false,
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

  it("keeps the legacy provider transcript fallback when no RuntimePlan is available", () => {
    const policy = resolveAttemptTranscriptPolicy({
      runtimePlanModelContext: {
        workspaceDir: "/tmp/openclaw-transcript-policy",
        modelApi: "openai-responses",
      },
      provider: "custom-openai-compatible",
      modelId: "gpt-5.4",
    });

    expect(policy).toMatchObject({
      sanitizeMode: "images-only",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      repairToolUseResultPairing: true,
      allowSyntheticToolResults: false,
    });
  });
});
