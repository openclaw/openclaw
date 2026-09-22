import { beforeEach, describe, expect, it, vi } from "vitest";
import { startCodexAttemptTurn } from "./run-attempt-turn-start.js";

const recovery = vi.hoisted(() => ({
  kind: "compact" as "compact" | "overflow" | "image",
  clearImageBinding: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  embeddedAgentLog: { info: vi.fn(), warn: vi.fn() },
  formatErrorMessage: (error: Error) => error.message,
  runAgentHarnessLlmInputHook: vi.fn(),
  runAgentHarnessLlmOutputHook: vi.fn(),
}));
vi.mock("./attempt-diagnostics.js", () => ({ classifyCodexModelCallFailureKind: () => undefined }));
vi.mock("./attempt-results.js", () => ({
  buildCodexTurnStartFailureResult: vi.fn(),
  isInvalidCodexImagePayloadError: () => recovery.kind === "image",
}));
vi.mock("./attempt-startup.js", () => ({
  isCodexContextRestartSelectionChangedError: () => false,
}));
vi.mock("./run-attempt-lifecycle.js", () => ({
  emitCodexAppServerEvent: vi.fn(),
  runCodexAgentEndHook: vi.fn(),
}));
vi.mock("./run-attempt-state.js", () => ({
  isCodexActiveCompactTurnError: () => recovery.kind === "compact",
  clearCodexBindingAfterInvalidImagePayload: recovery.clearImageBinding,
  shouldUseFreshCodexThreadAfterContextEngineOverflow: () => recovery.kind === "overflow",
}));
vi.mock("./session-binding.js", () => ({ assertCodexBindingMayBeReplaced: vi.fn() }));
vi.mock("./transcript-mirror.js", () => ({
  buildCodexUserPromptMessage: () => ({ role: "user", content: "reviewed continuation" }),
}));
vi.mock("./usage-limit-error.js", () => ({
  CodexUsageLimitPromptError: class extends Error {},
  formatCodexTurnStartUsageLimitError: async () => undefined,
  markCodexAuthProfileBlockedFromRateLimits: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function createFixture(acknowledged: boolean) {
  const originalError = new Error("native turn/start rejected");
  const startCodexTurn = vi.fn().mockRejectedValue(originalError);
  const waitForActiveNativeTurnCompletion = vi.fn().mockResolvedValue(true);
  const mutateBinding = vi.fn().mockResolvedValue(true);
  const restartContextEngineCodexThread = vi
    .fn()
    .mockResolvedValue({ threadId: "replacement-thread" });
  const state = {
    thread: { threadId: "reviewed-thread", connectionScope: "isolated" },
    restartContextEngineCodexThread,
  };
  // Only the start-recovery owner runs here. The mocked transport owns validation
  // of this opaque marker; the separate transport tests exercise real issuance.
  const resources = {
    state,
    markTrajectoryEndRecorded: vi.fn(),
    prompt: {
      turnState: { codexTurnPromptText: "reviewed continuation" },
      context: {
        historyState: { messages: [] },
        runtime: {
          runtimeParams: {},
          connection: {
            params: {
              runId: "next-run",
              sessionId: "session-1",
              provider: "openai",
              modelId: "test-model",
              ...(acknowledged ? { providerReviewAcknowledgment: {} } : {}),
            },
            runAbortController: new AbortController(),
            activeContextEngine: {},
            bindingStore: { mutate: mutateBinding, read: () => undefined },
            bindingIdentity: "binding-1",
            appServer: { requestTimeoutMs: 1000 },
            attemptStartedAt: 0,
          },
        },
      },
    },
  } as unknown as Parameters<typeof startCodexAttemptTurn>[0];
  const turnRuntime = { state: {}, turnIdRef: {} } as Parameters<typeof startCodexAttemptTurn>[1];
  const notifications = { waitForActiveNativeTurnCompletion } as unknown as Parameters<
    typeof startCodexAttemptTurn
  >[2];
  const requestRuntime = {
    startCodexTurn,
    buildLlmInputEvent: vi.fn(),
    codexModelCallDiagnostics: { emitStarted: vi.fn(), emitError: vi.fn() },
  } as unknown as Parameters<typeof startCodexAttemptTurn>[3];
  return {
    originalError,
    state,
    startCodexTurn,
    waitForActiveNativeTurnCompletion,
    mutateBinding,
    restartContextEngineCodexThread,
    run: () => startCodexAttemptTurn(resources, turnRuntime, notifications, requestRuntime),
  };
}

describe("native acknowledged turn recovery boundary", () => {
  it.each(["compact", "overflow", "image"] as const)(
    "retains the reviewed thread after %s rejection while preserving ordinary recovery",
    async (kind) => {
      recovery.kind = kind;
      const reviewed = createFixture(true);
      await expect(reviewed.run()).rejects.toBe(reviewed.originalError);
      expect(reviewed.startCodexTurn).toHaveBeenCalledTimes(1);
      expect(reviewed.waitForActiveNativeTurnCompletion).not.toHaveBeenCalled();
      expect(reviewed.mutateBinding).not.toHaveBeenCalled();
      expect(reviewed.restartContextEngineCodexThread).not.toHaveBeenCalled();
      expect(recovery.clearImageBinding).not.toHaveBeenCalled();
      expect(reviewed.state.thread.threadId).toBe("reviewed-thread");

      const ordinary = createFixture(false);
      await expect(ordinary.run()).rejects.toBe(ordinary.originalError);
      expect(ordinary.startCodexTurn).toHaveBeenCalledTimes(kind === "image" ? 1 : 2);
      expect(ordinary.waitForActiveNativeTurnCompletion).toHaveBeenCalledTimes(
        kind === "compact" ? 1 : 0,
      );
      expect(ordinary.mutateBinding).toHaveBeenCalledTimes(kind === "overflow" ? 1 : 0);
      expect(ordinary.restartContextEngineCodexThread).toHaveBeenCalledTimes(
        kind === "overflow" ? 1 : 0,
      );
      expect(recovery.clearImageBinding).toHaveBeenCalledTimes(kind === "image" ? 1 : 0);
    },
  );
});
