import { expect, it, vi } from "vitest";
import { startCodexAttemptTurn as startTurn } from "./run-attempt-turn-start.js";

type TurnArgs = Parameters<typeof startTurn>;

const recovery = vi.hoisted(() => ({
  kind: "compact" as "compact" | "overflow" | "image",
  forbidden: () => {
    throw new Error("A reviewed turn must not enter recovery");
  },
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
vi.mock("./run-attempt-lifecycle.js", () => ({
  emitCodexAppServerEvent: vi.fn(),
  runCodexAgentEndHook: vi.fn(),
}));
// mock-isolation: Select each rejection path without invoking real recovery or binding writes.
vi.mock("./run-attempt-state.js", () => ({
  isCodexActiveCompactTurnError: () => recovery.kind === "compact",
  clearCodexBindingAfterInvalidImagePayload: recovery.forbidden,
  shouldUseFreshCodexThreadAfterContextEngineOverflow: () => recovery.kind === "overflow",
}));
// mock-isolation: Any binding replacement is forbidden for this reviewed-turn fixture.
vi.mock("./session-binding.js", () => ({
  assertCodexBindingMayBeReplaced: recovery.forbidden,
  clearCodexBindingForClient: recovery.forbidden,
}));
vi.mock("./user-prompt-message.js", () => ({
  buildCodexUserPromptMessage: () => ({ role: "user", content: "reviewed continuation" }),
}));
// mock-isolation: Provider-review recovery does not read accounts or mutate auth-profile state.
vi.mock("./usage-limit-error.js", () => ({
  resolveCodexTurnStartError: async () => undefined,
  markCodexAuthProfileBlockedFromRateLimits: vi.fn(),
}));

it.each(["compact", "overflow", "image"] as const)(
  "retains the reviewed thread after %s rejection without retrying or clearing it",
  async (kind) => {
    recovery.kind = kind;
    const error = new Error("native turn/start rejected");
    const start = vi.fn().mockRejectedValue(error);
    const state = {
      thread: { threadId: "reviewed-thread", connectionScope: "isolated" },
      restartContextEngineCodexThread: recovery.forbidden,
    };
    // Transport tests own real acknowledgment issuance; this fixture isolates recovery.
    const resources = {
      state,
      prompt: {
        turnState: { codexTurnPromptText: "reviewed continuation" },
        context: {
          historyState: { messages: [] },
          runtime: {
            connection: {
              params: { providerReviewAcknowledgment: {} },
              runAbortController: new AbortController(),
              activeContextEngine: {},
              appServer: { requestTimeoutMs: 1000 },
            },
          },
        },
      },
    } as unknown as TurnArgs[0];
    const turnRuntime = { state: {}, turnIdRef: {} } as TurnArgs[1];
    const notifications = {
      waitForActiveNativeTurnCompletion: recovery.forbidden,
    } as unknown as TurnArgs[2];
    const requestRuntime = {
      startCodexTurn: start,
      buildLlmInputEvent: vi.fn(),
      buildLlmOutputEvent: vi.fn(),
      codexModelCallDiagnostics: { emitStarted: vi.fn(), emitError: vi.fn() },
    } as unknown as TurnArgs[3];
    await expect(startTurn(resources, turnRuntime, notifications, requestRuntime)).rejects.toBe(
      error,
    );
    expect(start).toHaveBeenCalledOnce();
    expect(state.thread.threadId).toBe("reviewed-thread");
  },
);
