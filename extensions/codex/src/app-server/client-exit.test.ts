import * as agentHarnessAttemptRuntime from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCodexAppServerIndeterminateTransportError } from "./client.js";
import { createClientHarness } from "./test-support.js";

describe("Codex app-server child exit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("marks a disconnected client and its indeterminate turn request as fallback stops", async () => {
    const recordStop = vi.spyOn(agentHarnessAttemptRuntime, "recordModelFallbackStop");
    const harness = createClientHarness({ autoEmitExit: false });
    const pending = harness.client
      .request("turn/start", { threadId: "thread-disconnected", input: [] })
      .catch((error: unknown) => error);
    const written = JSON.parse(await harness.waitForWrite(0)) as { method: string };
    expect(written.method).toBe("turn/start");

    harness.process.emit("exit", 1006, null);

    const error = await pending;
    const closeError = harness.client.getCloseError();
    expect(isCodexAppServerIndeterminateTransportError(error)).toBe(true);
    expect(error).toMatchObject({ mayHaveWritten: true, cause: closeError });
    expect(closeError).toMatchObject({ message: "codex app-server exited: code=1006 signal=null" });
    expect(recordStop).toHaveBeenCalledWith(closeError);
    expect(recordStop).toHaveBeenCalledWith(error);
    await expect(harness.client.request("model/list", {})).rejects.toBe(closeError);
    harness.process.stdout.destroy();
    harness.process.stderr.destroy();
  });

  it("marks a timed-out written request as a fallback stop without treating it as unwritten", async () => {
    vi.useFakeTimers();
    const recordStop = vi.spyOn(agentHarnessAttemptRuntime, "recordModelFallbackStop");
    const harness = createClientHarness({ autoEmitExit: false });
    const pending = harness.client
      .request("turn/start", { threadId: "thread-timeout", input: [] }, { timeoutMs: 100 })
      .catch((error: unknown) => error);
    await harness.waitForWrite(0);
    await vi.advanceTimersByTimeAsync(100);

    const error = await pending;
    expect(error).toMatchObject({
      code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
      reason: "timed out",
      mayHaveWritten: true,
      message: "turn/start timed out",
    });
    expect(recordStop).toHaveBeenCalledWith(error);
    harness.process.emit("exit", 0, null);
    harness.process.stdout.destroy();
    harness.process.stderr.destroy();
  });

  it.each([
    ["clean", 0, null],
    ["error", 1, null],
    ["signal", null, "SIGTERM"],
  ] as const)("settles repeated shutdown after %s exit", async (mode, code, signal) => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    const exited = vi.fn();
    harness.process.on("exit", exited);
    if (mode === "clean") {
      harness.client.close();
    } else {
      // A manual exit can arrive before the queued clean exit from stdin destruction.
      harness.process.stdin.destroy();
      harness.process.emit("exit", code, signal);
    }
    await vi.advanceTimersByTimeAsync(0);

    const settled = vi.fn();
    const closing = harness.client.closeAndWait().then(settled);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledExactlyOnceWith({ exited: true, cleanup: "uncertain" });
      await expect(harness.client.closeAndWait()).resolves.toEqual({
        exited: true,
        cleanup: "uncertain",
      });
      expect(exited).toHaveBeenCalledExactlyOnceWith(code, signal);
      expect(harness.process).toMatchObject({ exitCode: code, signalCode: signal });
      expect(harness.stdinDestroyed).toBe(true);
      expect(harness.process.stdout.destroyed).toBe(true);
      expect(harness.process.stderr.destroyed).toBe(true);
      expect(harness.process.kill).not.toHaveBeenCalled();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      await closing;
      harness.process.stdout.destroy();
      harness.process.stderr.destroy();
    }
  });
});
