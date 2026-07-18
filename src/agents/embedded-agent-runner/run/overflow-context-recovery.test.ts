// Covers the compaction-recovery admission gate for overflow recovery.
import { describe, expect, it } from "vitest";
import { recoverEmbeddedRunOverflow } from "./overflow-context-recovery.js";

type RecoveryInput = Parameters<typeof recoverEmbeddedRunOverflow>[0];

function createGateInput(overrides: Partial<RecoveryInput>): RecoveryInput {
  // Only the admission gate runs in these tests; everything past it is
  // unreachable and stubbed.
  return {
    runParams: {} as RecoveryInput["runParams"],
    state: {} as RecoveryInput["state"],
    contextEngine: {} as RecoveryInput["contextEngine"],
    contextTokenBudget: 1_024,
    genericCompactionRecoveryAllowed: true,
    aborted: false,
    signalOwnedInterruption: false,
    promptError: null,
    attempt: {} as RecoveryInput["attempt"],
    attemptCompactionCount: 0,
    runtimeAuthPlan: {} as RecoveryInput["runtimeAuthPlan"],
    resolvedSessionKey: "agent:test:main",
    sessionAgentId: "test",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    provider: "test-provider",
    modelId: "test-model",
    harnessRuntime: "openclaw",
    thinkLevel: undefined as RecoveryInput["thinkLevel"],
    authProfileIdSource: "auto",
    resolveContextEnginePluginId: () => undefined,
    buildRuntimeSettings: (() => ({})) as unknown as RecoveryInput["buildRuntimeSettings"],
    onCompactionHookMessages: async () => {},
    runOwnsCompactionBeforeHook: async () => {},
    runOwnsCompactionAfterHook: async () => {},
    adoptCompactionTranscript: async () => undefined,
    getActiveSession: (() => {
      throw new Error("gate must not reach the active session");
    }) as unknown as RecoveryInput["getActiveSession"],
    prepareCurrentTranscriptRetry: () => {
      throw new Error("gate must not prepare a retry");
    },
    prepareCompactedTranscriptRetry: async () => {
      throw new Error("gate must not prepare a compacted retry");
    },
    armPostCompactionGuard: () => {},
    ...overrides,
  };
}

describe("recoverEmbeddedRunOverflow admission gate", () => {
  it("does not compact a real overflow when compaction recovery is disallowed", async () => {
    const outcome = await recoverEmbeddedRunOverflow(
      createGateInput({
        genericCompactionRecoveryAllowed: false,
        promptError: new Error(
          "input length and max tokens exceed context limit: 250000 tokens > 200000 maximum",
        ),
      }),
    );

    expect(outcome).toEqual({ action: "none" });
  });

  it("does not treat a non-overflow prompt failure as recoverable", async () => {
    const outcome = await recoverEmbeddedRunOverflow(
      createGateInput({
        promptError: new Error("connection reset by peer"),
      }),
    );

    expect(outcome).toEqual({ action: "none" });
  });
});
