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
  it("observes accepted requests without spending the execution budget", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const harness = createStartedThreadHarness();
    const turnAccepted = createDeferred<void>();
    const params = createTestParams();
    params.timeoutMs = 1;
    params.onExecutionPhase = ({ phase }) => {
      if (phase === "turn_accepted") {
        turnAccepted.resolve();
      }
    };
    const run = runCodexAppServerAttempt(params);
    await Promise.race([turnAccepted.promise, run]);

    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    expect(readAttemptTerminal(await run)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
  });

  it("stops accepted native work when published-backend activation fails", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.permissionChange = {
      owner: {},
      baseExecOverrides: {},
      request: async () => false,
      applied: () => {
        throw new Error("activation failed");
      },
      recordApplied: () => {},
    };
    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("activation failed");
    expect(
      harness.requests.filter(({ method }) =>
        ["turn/interrupt", "thread/backgroundTerminals/list", "thread/unsubscribe"].includes(
          method,
        ),
      ),
    ).toEqual([
      { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
      { method: "thread/backgroundTerminals/list", params: { threadId: "thread-1" } },
      { method: "thread/unsubscribe", params: { threadId: "thread-1" } },
    ]);
    expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBeUndefined();
    expect(harness.client.getCloseError()).toBeUndefined();
  });
});
