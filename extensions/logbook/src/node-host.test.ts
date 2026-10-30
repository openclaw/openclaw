import { once } from "node:events";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";

const { readFileMock, rmMock, runExecMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(async () => Buffer.from("jpeg")),
  rmMock: vi.fn(async () => undefined),
  runExecMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  readFile: readFileMock,
  rm: rmMock,
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runExec: runExecMock }));
vi.mock("openclaw/plugin-sdk/temp-path", () => ({
  resolvePreferredOpenClawTmpDir: () => "/data/openclaw-tests",
}));

import { handleLogbookSnapshot } from "./node-host.js";

type RunExecOptions = { logOutput?: boolean; signal?: AbortSignal };

function runExecSignal(callIndex: number): AbortSignal {
  const options = runExecMock.mock.calls[callIndex]?.[2] as RunExecOptions | undefined;
  assert(options?.signal, `missing runExec signal for call ${callIndex}`);
  return options.signal;
}

async function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  signal.throwIfAborted();
  await once(signal, "abort");
  throw signal.reason;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new DOMException("snapshot command timed out", "TimeoutError"));
    }, timeoutMs);
    return controller.signal;
  });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([0, 20_000])(
  "aborts at the shared deadline with capture progress after %i ms",
  async (captureMs) => {
    runExecMock.mockImplementation(
      async (command: string, _args: string[], options: RunExecOptions) => {
        if (command === "screencapture" && captureMs) {
          return await new Promise<{ stdout: string; stderr: string }>((resolve) => {
            setTimeout(() => resolve({ stdout: "", stderr: "" }), captureMs);
          });
        }
        return await rejectWhenAborted(options.signal as AbortSignal);
      },
    );

    const snapshot = handleLogbookSnapshot({});
    await vi.advanceTimersByTimeAsync(0);
    const captureSignal = runExecSignal(0);
    if (captureMs) {
      await vi.advanceTimersByTimeAsync(captureMs - 1);
      expect(runExecMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(24_999 - captureMs);
    expect(captureSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(snapshot).resolves.toEqual({ error: "snapshot command timed out" });
    expect(captureSignal.aborted).toBe(true);
    const commands = captureMs ? ["screencapture", "sips"] : ["screencapture"];
    expect(runExecMock.mock.calls.map(([command]) => command)).toEqual(commands);
    expect(commands.map((_, index) => runExecSignal(index))).toEqual(
      commands.map(() => captureSignal),
    );
    expect(readFileMock).not.toHaveBeenCalled();
    expect(rmMock).toHaveBeenCalledOnce();
  },
);
