// execCommand tests cover child-process output retention, limits, and timeout
// termination semantics used by agent sessions.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { execCommand, type ExecOptions } from "./exec.js";

const { spawnMock, terminateMock, settleTerminationMock, windowsLegacyOutput } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  terminateMock: vi.fn(),
  settleTerminationMock: vi.fn(),
  windowsLegacyOutput: { enabled: false },
}));
vi.mock("../../infra/windows-encoding.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../infra/windows-encoding.js")>();
  return {
    ...original,
    createWindowsOutputDecoder: (
      params?: Parameters<typeof original.createWindowsOutputDecoder>[0],
    ) =>
      original.createWindowsOutputDecoder({
        ...params,
        ...(windowsLegacyOutput.enabled
          ? { platform: "win32", windowsEncoding: "gbk" }
          : { platform: "linux" }),
      }),
  };
});
// mock-isolation: Exercise session capture and cancellation without launching native process trees.
vi.mock("../../process/supervisor/adapters/child.js", () => ({ createChildAdapter: spawnMock }));

async function startCommand(options?: ExecOptions, pending = false) {
  const stdout = new EventEmitter(),
    stderr = new EventEmitter();
  const wait = createDeferred<number | null>();
  const started = createDeferred();
  const child = {
    pid: 1234,
    memoryRootPid: 1234,
    supportsRawOutput: true,
    stdout,
    stderr,
    kill: terminateMock,
    dispose: vi.fn(),
    onExit: vi.fn(),
    onStdout: (_listener: (chunk: string) => void, raw: (chunk: Buffer) => void) =>
      stdout.on("data", raw),
    onStderr: (_listener: (chunk: string) => void, raw: (chunk: Buffer) => void) =>
      stderr.on("data", raw),
    wait: () => wait.promise.then((code) => ({ code, signal: null })),
    waitForExtinction: settleTerminationMock,
  };
  stdout.on("error", () => {});
  stderr.on("error", () => {});
  spawnMock.mockResolvedValue({ adapter: child, ready: started.promise });
  const resultPromise = execCommand("cmd", [], "/tmp", options);
  if (!pending) {
    started.resolve();
  }
  await Promise.resolve();
  await Promise.resolve();
  return { child, wait, started, resultPromise };
}

describe("execCommand", () => {
  beforeEach(() => {
    terminateMock.mockReset();
    settleTerminationMock.mockReset();
    settleTerminationMock.mockResolvedValue(undefined);
    spawnMock.mockReset();
    windowsLegacyOutput.enabled = false;
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("bounds retained stdout and stderr independently", async () => {
    // stdout and stderr are separate buffers; a noisy stream must not evict the
    // diagnostic tail from the other stream.
    const { child, wait, resultPromise } = await startCommand({ maxOutputChars: 256 });
    child.stdout.emit("data", Buffer.from(`${"a".repeat(300)}stdout-tail`));
    child.stderr.emit("data", Buffer.from(`${"b".repeat(300)}stderr-tail`));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(256);
    expect(result.stderr.length).toBeLessThanOrEqual(256);
    expect(result.stdout.endsWith("stdout-tail")).toBe(true);
    expect(result.stderr.endsWith("stderr-tail")).toBe(true);
    expect(result.stdoutTruncatedChars).toBeGreaterThan(0);
    expect(result.stderrTruncatedChars).toBeGreaterThan(0);
  });

  it("retains output received while native startup is pending", async () => {
    const { child, wait, started, resultPromise } = await startCommand(undefined, true);
    child.stdout.emit("data", Buffer.from("stdout-before-ready"));
    child.stderr.emit("data", Buffer.from("stderr-before-ready"));
    started.resolve();
    wait.resolve(0);
    await expect(resultPromise).resolves.toMatchObject({
      code: 0,
      stdout: "stdout-before-ready",
      stderr: "stderr-before-ready",
    });
  });

  it("honors caller-supplied small output caps", async () => {
    const { child, wait, resultPromise } = await startCommand({ maxOutputChars: 3 });
    child.stdout.emit("data", Buffer.from("abcdef"));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("def");
    expect(result.stdoutTruncatedChars).toBe(3);
  });

  it("keeps caller-capped retained output UTF-16 safe", async () => {
    const { child, wait, resultPromise } = await startCommand({ maxOutputChars: 2 });
    child.stdout.emit("data", Buffer.from("A😀B"));
    child.stderr.emit("data", Buffer.from("C😀D"));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.stdout).toBe("B");
    expect(result.stderr).toBe("D");
    expect(result.stdoutTruncatedChars).toBe(3);
    expect(result.stderrTruncatedChars).toBe(3);
  });

  it("preserves UTF-8 characters split across stdout and stderr chunks", async () => {
    const { child, wait, resultPromise } = await startCommand();
    const stdout = Buffer.from("stdout-😀-complete", "utf8");
    const stderr = Buffer.from("stderr-😀-complete", "utf8");
    child.stdout.emit("data", stdout.subarray(0, 9));
    child.stderr.emit("data", stderr.subarray(0, 9));
    child.stdout.emit("data", stdout.subarray(9));
    child.stderr.emit("data", stderr.subarray(9));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.stdout).toBe("stdout-😀-complete");
    expect(result.stderr).toBe("stderr-😀-complete");
  });

  it("preserves leading UTF-8 BOMs in stdout and stderr", async () => {
    const { child, wait, resultPromise } = await startCommand();
    const stdout = Buffer.from("\uFEFFstdout", "utf8");
    const stderr = Buffer.from("\uFEFFstderr", "utf8");
    child.stdout.emit("data", stdout.subarray(0, 1));
    child.stdout.emit("data", stdout.subarray(1, 2));
    child.stdout.emit("data", stdout.subarray(2));
    child.stderr.emit("data", stderr.subarray(0, 2));
    child.stderr.emit("data", stderr.subarray(2));
    wait.resolve(0);

    await expect(resultPromise).resolves.toMatchObject({
      stdout: "\uFEFFstdout",
      stderr: "\uFEFFstderr",
    });
  });

  it("decodes split GBK stdout on legacy-codepage Windows", async () => {
    windowsLegacyOutput.enabled = true;
    const { child, wait, resultPromise } = await startCommand();
    child.stdout.emit("data", Buffer.from([0xb2]));
    child.stdout.emit("data", Buffer.from([0xe2, 0xca]));
    child.stdout.emit("data", Buffer.from([0xd4]));
    wait.resolve(0);

    await expect(resultPromise).resolves.toMatchObject({ stdout: "测试" });
  });

  it("decodes split GBK stderr on legacy-codepage Windows", async () => {
    windowsLegacyOutput.enabled = true;
    const { child, wait, resultPromise } = await startCommand();
    child.stderr.emit("data", Buffer.from([0xc4]));
    child.stderr.emit("data", Buffer.from([0xe3, 0xba]));
    child.stderr.emit("data", Buffer.from([0xc3]));
    wait.resolve(0);

    await expect(resultPromise).resolves.toMatchObject({ stderr: "你好" });
  });

  it("preserves split UTF-8 output on legacy-codepage Windows", async () => {
    windowsLegacyOutput.enabled = true;
    const { child, wait, resultPromise } = await startCommand();
    const stdout = Buffer.from("测试", "utf8");
    child.stdout.emit("data", stdout.subarray(0, 1));
    child.stdout.emit("data", stdout.subarray(1, 3));
    child.stdout.emit("data", stdout.subarray(3));
    wait.resolve(0);

    await expect(resultPromise).resolves.toMatchObject({ stdout: "测试" });
  });

  it("flushes incomplete UTF-8 sequences when the process exits", async () => {
    const { child, wait, resultPromise } = await startCommand();
    child.stdout.emit("data", Buffer.from([0xe2, 0x82]));
    child.stderr.emit("data", Buffer.from([0xf0, 0x9f, 0x98]));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.stdout).toBe("�");
    expect(result.stderr).toBe("�");
  });

  it("fails instead of silently truncating default exec output", async () => {
    const { child, wait, resultPromise } = await startCommand();
    child.stdout.emit("data", Buffer.from(`${"x".repeat(16 * 1024 * 1024 - 1)}😀`));
    wait.resolve(0);

    const result = await resultPromise;
    expect(terminateMock).toHaveBeenCalledOnce();
    expect(result.code).toBe(1);
    expect(result.killed).toBe(true);
    expect(result.outputLimitExceeded).toBe("stdout");
    expect(result.stdout.length).toBe(16 * 1024 * 1024 - 1);
    expect(result.stdout.endsWith("x")).toBe(true);
    expect(result.stdoutTruncatedChars).toBe(2);
    expect(result.stderr).toContain("exec stdout exceeded output limit");
  });

  it("terminates timed-out commands through the process-tree killer", async () => {
    // Extension exec uses the same tree-kill boundary as the built-in shell so
    // timed-out wrappers do not leave descendant processes running.
    vi.useFakeTimers();
    const { wait, resultPromise } = await startCommand({ timeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(terminateMock).toHaveBeenCalledOnce();

    wait.resolve(null);
    const result = await resultPromise;
    expect(result.killed).toBe(true);
  });

  it.each([false, true])(
    "bounds Windows fallback cancellation until tree cleanup (cooperative=%s)",
    async (cooperative) => {
      mockProcessPlatform("win32");
      vi.useFakeTimers();
      const cleanup = createDeferred();
      settleTerminationMock.mockReturnValue(cleanup.promise);
      terminateMock.mockImplementation((signal) => {
        if (signal === "SIGKILL") {
          cleanup.resolve();
        }
      });
      const { wait, resultPromise } = await startCommand({ timeout: 10 });
      try {
        await vi.advanceTimersByTimeAsync(10);
        // Root completion does not certify that its descendants have stopped.
        wait.resolve(null);
        if (cooperative) {
          cleanup.resolve();
          await resultPromise;
        }
        await vi.advanceTimersByTimeAsync(4999);
        expect(terminateMock.mock.calls).toEqual([["SIGTERM"]]);
        await vi.advanceTimersByTimeAsync(1);
        expect(terminateMock.mock.calls).toEqual(
          cooperative ? [["SIGTERM"]] : [["SIGTERM"], ["SIGKILL"]],
        );
        await expect(resultPromise).resolves.toMatchObject({ killed: true });
      } finally {
        wait.resolve(null);
        cleanup.resolve();
        await resultPromise;
      }
    },
  );

  it.each(["abort", "timeout"] as const)(
    "settles %s while startup is pending and retains cleanup for a late process",
    async (reason) => {
      vi.useFakeTimers();
      const cleanup = createDeferred();
      settleTerminationMock.mockReturnValue(cleanup.promise);
      const controller = new AbortController();
      const {
        started,
        wait,
        resultPromise: result,
      } = await startCommand(
        {
          signal: controller.signal,
          ...(reason === "timeout" ? { timeout: 10 } : {}),
        },
        true,
      );
      let outcome: Awaited<typeof result> | undefined;
      void result.then((value) => {
        outcome = value;
      });
      try {
        if (reason === "abort") {
          controller.abort();
        }
        await vi.advanceTimersByTimeAsync(10);
        expect(outcome).toMatchObject({ code: 1, killed: true, stdout: "", stderr: "" });
        expect(spawnMock.mock.calls[0]?.[0].abortSignal.aborted).toBe(true);
        started.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(terminateMock).toHaveBeenCalledOnce();
        wait.resolve(null);
        cleanup.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(settleTerminationMock).toHaveBeenCalledOnce();
      } finally {
        started.resolve();
        wait.resolve(null);
        cleanup.resolve();
        await result;
      }
    },
  );

  it("does not resolve a killed command until process-tree cleanup settles", async () => {
    vi.useFakeTimers();
    const cleanup = createDeferred();
    settleTerminationMock.mockReturnValue(cleanup.promise);
    const { wait, resultPromise } = await startCommand({ timeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    wait.resolve(null);
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(resolved).toBe(false);
    cleanup.resolve();
    await expect(resultPromise).resolves.toMatchObject({ killed: true });
  });

  it("does not crash when stdout or stderr emit an error event", async () => {
    const { child, wait, resultPromise } = await startCommand();
    child.stdout.emit("error", new Error("EPIPE"));
    child.stderr.emit("error", new Error("EIO"));
    wait.resolve(0);

    await expect(resultPromise).resolves.toMatchObject({ code: 0 });
  });

  it.each([false, true])(
    "classifies rejected native cleanup without a command result (ready=%s)",
    async (ready) => {
      const failure = new Error("native owner lost extinction evidence");
      settleTerminationMock.mockRejectedValue(failure);
      const { started, wait, resultPromise } = await startCommand(undefined, !ready);
      const rejected = expect(resultPromise).rejects.toSatisfy(
        (error: unknown) =>
          hasCommandProcessCleanupError(error) && error instanceof Error && error.cause === failure,
      );
      (ready ? wait : started).reject(new Error("native process failed"));
      await rejected;
    },
  );
});
