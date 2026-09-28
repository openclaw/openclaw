import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import { resolveAttemptTranscriptPolicy } from "./attempt-history.js";

const resolveProviderRuntimePluginMock = vi.hoisted(() => vi.fn());

// Keep provider discovery out of this adapter test.
vi.mock("../../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: resolveProviderRuntimePluginMock,
  resolveProviderRuntimePluginHandle: vi.fn(),
  clearProviderRuntimePluginCacheForTest: vi.fn(),
}));

describe("resolveAttemptTranscriptPolicy", () => {
  beforeEach(() => {
    resolveProviderRuntimePluginMock.mockReset();
    resolveProviderRuntimePluginMock.mockReturnValue(undefined);
  });

  it("uses RuntimePlan transcript policy when available", () => {
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
});
