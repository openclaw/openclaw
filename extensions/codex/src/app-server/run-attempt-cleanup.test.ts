import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  clearActiveEmbeddedRun: vi.fn(),
  runAgentCleanupStep: vi.fn(async (input: { cleanup: () => Promise<void>; step: string }) => {
    await input.cleanup();
  }),
  unsubscribeCodexThreadBestEffort: vi.fn(async () => true),
  scheduleCodexNativeHookRelayUnregister: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  clearActiveEmbeddedRun: hoisted.clearActiveEmbeddedRun,
  embeddedAgentLog: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  runAgentCleanupStep: hoisted.runAgentCleanupStep,
}));
vi.mock("./attempt-client-cleanup.js", () => ({
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS: 5_000,
  unsubscribeCodexThreadBestEffort: hoisted.unsubscribeCodexThreadBestEffort,
}));
vi.mock("./native-hook-relay.js", () => ({
  scheduleCodexNativeHookRelayUnregister: hoisted.scheduleCodexNativeHookRelayUnregister,
}));

import { cleanupCodexAttempt } from "./run-attempt-cleanup.js";

function createFixture(
  overrides: {
    trajectoryTerminalStatus?: "success" | "error" | "interrupted";
    trajectoryEndRecorded?: boolean;
  } = {},
) {
  const order: string[] = [];
  const trajectoryRecorder = {
    recordEvent: vi.fn((type: string) => {
      order.push(type);
    }),
    flush: vi.fn(async () => {
      order.push("flush");
    }),
  };
  const releaseCurrentRoute = vi.fn(() => {
    order.push("release-route");
  });
  const releaseSharedClientLeaseAndRetireOneShotClient = vi.fn(async () => {
    order.push("release-client");
  });
  const releaseSandboxExecEnvironment = vi.fn(async () => {
    order.push("release-sandbox");
  });
  const disposeScopedMcp = vi.fn(async () => {
    order.push("dispose-mcp");
  });
  const detachBackend = vi.fn(() => {
    order.push("detach-backend");
  });
  const freezeRunTerminalOutcome = vi.fn(() => {
    order.push("freeze-terminal");
  });
  const resources = {
    prompt: {
      context: {
        runtime: {
          connection: {
            params: {
              runId: "run-1",
              sessionId: "session-1",
              sessionKey: "agent:main:session-1",
              sessionFile: "/tmp/session.jsonl",
              isFinalFallbackAttempt: true,
              replyOperation: { detachBackend },
            },
            options: {},
            runAbortController: { signal: { aborted: false, removeEventListener: vi.fn() } },
          },
        },
        attemptTools: {
          toolState: { yieldDetected: false },
          scopedMcpTools: { dispose: disposeScopedMcp },
        },
      },
    },
    state: {
      client: { request: vi.fn() },
      thread: { threadId: "thread-1" },
      trajectoryEndRecorded: overrides.trajectoryEndRecorded ?? false,
      trajectoryTerminalStatus: overrides.trajectoryTerminalStatus ?? "success",
      trajectoryTerminalPromptError: undefined,
      trajectoryTerminalTimedOut: false,
      trajectoryTerminalYieldDetected: false,
      nativeHookRelay: undefined,
    },
    trajectoryRecorder,
    releaseCurrentRoute,
    releaseSharedClientLeaseAndRetireOneShotClient,
    releaseSandboxExecEnvironment,
  };
  const turnRuntime = {
    state: {
      timedOut: false,
      clientClosedAbort: false,
      shouldDelayNativeHookRelayUnregister: false,
    },
    steeringQueueRef: { current: { flushPending: vi.fn(async () => undefined), cancel: vi.fn() } },
    userInputBridgeRef: { current: { cancelPending: vi.fn() } },
    turnWatches: { clearAllTimers: vi.fn() },
  };
  const lifecycle = {
    maybeEmitFastModeAutoResetBestEffort: vi.fn(async () => undefined),
    emitLifecycleTerminal: vi.fn(),
    buildLifecycleTerminalMeta: vi.fn(() => ({})),
  };
  const requestRuntime = {
    codexModelCallDiagnostics: { emitError: vi.fn() },
  };
  const activeTurn = {
    activeTurnId: "turn-1",
    abortListener: vi.fn(),
    handle: { kind: "codex" },
    freezeRunTerminalOutcome,
  };

  hoisted.runAgentCleanupStep.mockImplementation(
    async (input: { cleanup: () => Promise<void>; step: string }) => {
      if (input.step.includes("flush")) {
        order.push("flush-step");
      }
      if (input.step.includes("mcp")) {
        order.push("mcp-step");
      }
      await input.cleanup();
    },
  );

  return {
    order,
    trajectoryRecorder,
    resources,
    turnRuntime,
    lifecycle,
    requestRuntime,
    activeTurn,
  };
}

describe("cleanupCodexAttempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records session.ended after resource cleanup and preserves terminal status", async () => {
    const fixture = createFixture({ trajectoryTerminalStatus: "success" });

    await cleanupCodexAttempt(
      fixture.resources as never,
      fixture.turnRuntime as never,
      fixture.lifecycle as never,
      fixture.requestRuntime as never,
      fixture.activeTurn as never,
    );

    expect(fixture.order).toEqual([
      "flush-step",
      "flush",
      "release-route",
      "release-client",
      "release-sandbox",
      "mcp-step",
      "dispose-mcp",
      "freeze-terminal",
      "detach-backend",
      "session.ended",
      "flush-step",
      "flush",
    ]);
    expect(fixture.trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "session.ended",
      expect.objectContaining({
        status: "success",
        threadId: "thread-1",
        turnId: "turn-1",
        timedOut: false,
        aborted: false,
      }),
    );
    expect(hoisted.clearActiveEmbeddedRun).toHaveBeenCalledWith(
      "session-1",
      fixture.activeTurn.handle,
      "agent:main:session-1",
      "/tmp/session.jsonl",
    );
  });

  it("skips session.ended when the terminal event was already recorded", async () => {
    const fixture = createFixture({ trajectoryEndRecorded: true });

    await cleanupCodexAttempt(
      fixture.resources as never,
      fixture.turnRuntime as never,
      fixture.lifecycle as never,
      fixture.requestRuntime as never,
      fixture.activeTurn as never,
    );

    expect(fixture.trajectoryRecorder.recordEvent).not.toHaveBeenCalled();
    expect(fixture.order).not.toContain("session.ended");
  });
});
