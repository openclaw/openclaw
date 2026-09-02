import { describe, expect, it, vi } from "vitest";
import { cleanupCodexAttempt } from "./run-attempt-cleanup.js";

describe("Codex attempt transcript cleanup", () => {
  it("surfaces checkpoint persistence failure after completing cleanup", async () => {
    const persistenceFailure = new Error("transcript persistence failed");
    const runCleanupStep = vi.fn(async (_name: string, operation: () => unknown) => {
      try {
        await operation();
      } catch {}
    });
    const releaseSandboxExecEnvironment = vi.fn();
    const releaseCurrentRoute = vi.fn();

    await expect(
      cleanupCodexAttempt(
        {
          prompt: {
            context: {
              attemptTools: {
                runCleanups: [],
                scheduledAppAuthoritySourceRef: { current: undefined },
              },
              runtime: {
                connection: {
                  bindingIdentity: {},
                  bindingStore: {},
                  options: {},
                  params: {
                    sessionFile: "/tmp/session.jsonl",
                    sessionId: "session-1",
                    sessionKey: "agent:main:session-1",
                  },
                  runAbortController: new AbortController(),
                  terminalState: { turnSucceeded: false },
                },
              },
            },
          },
          releaseCurrentRoute,
          releaseSandboxExecEnvironment,
          releaseSharedClientLeaseAndRetireOneShotClient: vi.fn(),
          runCleanupStep,
          state: {
            thread: {
              clientId: "client-1",
              threadId: "thread-1",
            },
            trajectoryEndRecorded: true,
          },
        } as never,
        {
          state: {
            abortCleanup: Promise.resolve(),
            timedOut: true,
          },
          steeringQueueRef: { current: undefined },
          turnWatches: { clearAllTimers: vi.fn() },
          userInputBridgeRef: { current: undefined },
        } as never,
        {
          buildLifecycleTerminalMeta: vi.fn(() => ({})),
          emitLifecycleTerminal: vi.fn(),
          maybeEmitFastModeAutoResetBestEffort: vi.fn(),
        } as never,
        {
          codexModelCallDiagnostics: {
            emitError: vi.fn(),
          },
        } as never,
        {
          abortListener: vi.fn(),
          activeProjector: {
            closeProjection: vi.fn(async () => {
              throw persistenceFailure;
            }),
          },
          freezeRunTerminalOutcome: vi.fn(),
          handle: {},
        } as never,
      ),
    ).rejects.toBe(persistenceFailure);

    expect(releaseCurrentRoute).toHaveBeenCalledOnce();
    expect(releaseSandboxExecEnvironment).toHaveBeenCalledOnce();
    expect(runCleanupStep.mock.calls.some(([name]) => name === "codex-transcript-checkpoint")).toBe(
      true,
    );
  });
});
