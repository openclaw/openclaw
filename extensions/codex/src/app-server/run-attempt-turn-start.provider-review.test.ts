import { beforeEach, expect, it, vi } from "vitest";
import { startCodexAttemptTurn as startTurn } from "./run-attempt-turn-start.js";

type TurnArgs = Parameters<typeof startTurn>;

const recovery = vi.hoisted(() => ({
  kind: "compact" as "compact" | "overflow" | "image",
  clearImageBinding: vi.fn(),
  clearBinding: vi.fn(),
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
vi.mock("./run-attempt-state.js", () => ({
  isCodexActiveCompactTurnError: () => recovery.kind === "compact",
  clearCodexBindingAfterInvalidImagePayload: recovery.clearImageBinding,
  shouldUseFreshCodexThreadAfterContextEngineOverflow: () => recovery.kind === "overflow",
}));
vi.mock("./session-binding.js", () => ({
  assertCodexBindingMayBeReplaced: vi.fn(),
  clearCodexBindingForClient: recovery.clearBinding,
}));
vi.mock("./user-prompt-message.js", () => ({
  buildCodexUserPromptMessage: () => ({ role: "user", content: "reviewed continuation" }),
}));
// mock-isolation: Provider-review recovery does not read accounts or mutate auth-profile state.
vi.mock("./usage-limit-error.js", () => ({
  resolveCodexTurnStartError: async () => undefined,
  markCodexAuthProfileBlockedFromRateLimits: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

function createFixture() {
  const error = new Error("native turn/start rejected");
  const start = vi.fn().mockRejectedValue(error);
  const wait = vi.fn().mockResolvedValue(true);
  const clear = recovery.clearBinding.mockResolvedValue(true);
  const restart = vi.fn().mockResolvedValue({ threadId: "replacement-thread" });
  const state = {
    thread: { threadId: "reviewed-thread", connectionScope: "isolated" },
    restartContextEngineCodexThread: restart,
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
  const notifications = { waitForActiveNativeTurnCompletion: wait } as unknown as TurnArgs[2];
  const requestRuntime = {
    startCodexTurn: start,
    buildLlmInputEvent: vi.fn(),
    buildLlmOutputEvent: vi.fn(),
    codexModelCallDiagnostics: { emitStarted: vi.fn(), emitError: vi.fn() },
  } as unknown as TurnArgs[3];
  // Counts retain the start/wait/clear/restart/image-clear ordering.
  const calls = [start, wait, clear, restart, recovery.clearImageBinding];
  return {
    error,
    state,
    counts: () => calls.map((call) => call.mock.calls.length),
    run: () => startTurn(resources, turnRuntime, notifications, requestRuntime),
  };
}

it.each(["compact", "overflow", "image"] as const)(
  "retains the reviewed thread after %s rejection without retrying or clearing it",
  async (kind) => {
    recovery.kind = kind;
    const reviewed = createFixture();
    await expect(reviewed.run()).rejects.toBe(reviewed.error);
    expect(reviewed.counts()).toEqual([1, 0, 0, 0, 0]);
    expect(reviewed.state.thread.threadId).toBe("reviewed-thread");
  },
);
