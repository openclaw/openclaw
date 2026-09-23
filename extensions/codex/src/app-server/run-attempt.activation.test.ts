import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt activation ownership", () => {
  it.each(["execution observer", "published backend"] as const)(
    "stops accepted native work when activation fails at %s",
    async (stage) => {
      const harness = createStartedThreadHarness();
      const params = createTestParams();
      const failActivation = () => {
        throw new Error("activation failed");
      };
      if (stage === "execution observer") {
        params.onExecutionPhase = failActivation;
      } else {
        params.permissionChange = {
          owner: {},
          baseExecOverrides: {},
          request: async () => false,
          applied: failActivation,
          recordApplied: () => {},
        };
      }

      await expect(runCodexAppServerAttempt(params)).rejects.toThrow("activation failed");

      const cleanup = harness.requests.filter(({ method }) =>
        ["turn/interrupt", "thread/backgroundTerminals/list", "thread/unsubscribe"].includes(
          method,
        ),
      );
      expect(cleanup).toEqual([
        { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
        { method: "thread/backgroundTerminals/list", params: { threadId: "thread-1" } },
        { method: "thread/unsubscribe", params: { threadId: "thread-1" } },
      ]);
      expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBeUndefined();
      expect(harness.client.getCloseError()).toBeUndefined();
    },
  );

  it("releases completion when the app-server client closes during an active turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const harness = createStartedThreadHarness();
    const turnAccepted = createDeferred<void>();
    const params: ReturnType<typeof createTestParams> = {
      ...createTestParams(),
      onExecutionPhase: ({ phase }) => {
        if (phase === "turn_accepted") {
          turnAccepted.resolve();
        }
      },
    };
    const run = runCodexAppServerAttempt(params);

    await Promise.race([
      turnAccepted.promise,
      run.then(() => {
        throw new Error("Codex attempt ended before turn acceptance");
      }),
    ]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    harness.close(
      new Error('codex app-server exited: code=137 signal=SIGKILL stderr="worker exhausted"'),
    );

    const result = await run;
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server client closed before turn completed",
    );
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(result.codexAppServerFailure).toEqual({
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: true,
      diagnostics: {
        transportError:
          'codex app-server exited: code=137 signal=SIGKILL stderr="worker exhausted"',
      },
    });
  });
});
