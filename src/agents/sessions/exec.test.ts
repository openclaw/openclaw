// execCommand tests cover child-process output retention, limits, and timeout
// termination semantics used by agent sessions.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { execCommand, type ExecOptions } from "./exec.js";

const {
  completionMock,
  createTerminationControllerMock,
  settleTerminationMock,
  spawnMock,
  terminateMock,
  waitForSpawnMock,
} = vi.hoisted(() => ({
  completionMock: vi.fn(),
  createTerminationControllerMock: vi.fn(),
  settleTerminationMock: vi.fn(),
  spawnMock: vi.fn(),
  terminateMock: vi.fn(),
  waitForSpawnMock: vi.fn(),
}));

// mock-isolation: Keep host codepage discovery outside this platform-independent exec fixture.
vi.mock("../../infra/windows-encoding.js", async (importOriginal) => {
  const { createWindowsOutputDecoder } =
    await importOriginal<typeof import("../../infra/windows-encoding.js")>();
  return {
    createWindowsOutputDecoder: (params?: Parameters<typeof createWindowsOutputDecoder>[0]) =>
      createWindowsOutputDecoder({
        ...params,
        platform: "linux",
      }),
  };
});

vi.mock("../../process/child-process.js", () => ({
  releaseChildProcessOutputAfterExit: vi.fn(() => vi.fn()),
}));

vi.mock("../../process/exec.js", () => ({
  spawnCommand: (...args: unknown[]) => {
    const child = spawnMock(...args) as StubChild;
    const completion = completionMock(child).then((code: number | null) => ({
      exitCode: code,
      failed: false,
    }));
    // oxlint-disable-next-line unicorn/no-thenable -- Execa subprocesses are event emitters and promises.
    child.then = completion.then.bind(completion);
    return child;
  },
}));

vi.mock("../../process/exec-termination.js", () => ({
  createCommandTerminationController: createTerminationControllerMock,
}));

vi.mock("../../process/exec-spawn.js", () => ({
  waitForCommandSpawn: waitForSpawnMock,
}));

type StubChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  nodeChildProcess: StubChild;
  pid?: number;
  stderr: EventEmitter;
  stdout: EventEmitter;
  then: Promise<unknown>["then"];
};

function createStubChild(): StubChild {
  const child = new EventEmitter() as StubChild;
  child.nodeChildProcess = child;
  child.pid = 1234;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  // oxlint-disable-next-line unicorn/no-thenable -- Stub matches Execa's event-emitting promise shape.
  child.then = vi.fn() as unknown as Promise<unknown>["then"];
  return child;
}

function startCommand(options?: ExecOptions) {
  const child = createStubChild();
  const wait = createDeferred<number | null>();
  spawnMock.mockReturnValue(child);
  completionMock.mockReturnValue(wait.promise);
  return { child, wait, resultPromise: execCommand("cmd", [], "/tmp", options) };
}

describe("execCommand", () => {
  beforeEach(() => {
    createTerminationControllerMock.mockReset();
    terminateMock.mockReset();
    terminateMock.mockReturnValue(false);
    settleTerminationMock.mockReset();
    settleTerminationMock.mockResolvedValue(undefined);
    createTerminationControllerMock.mockReturnValue({
      terminate: terminateMock,
      settle: settleTerminationMock,
    });
    spawnMock.mockReset();
    completionMock.mockReset();
    waitForSpawnMock.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("captures output when the transport supplies process pipes asynchronously", async () => {
    const child = createStubChild();
    const stdout = child.stdout;
    const stderr = child.stderr;
    const spawned = createDeferred();
    const completion = createDeferred<number | null>();
    let ready = false;
    child.pid = undefined;
    Object.defineProperty(child, "stdout", { get: () => (ready ? stdout : undefined) });
    Object.defineProperty(child, "stderr", { get: () => (ready ? stderr : undefined) });
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(completion.promise);
    waitForSpawnMock.mockReturnValue(spawned.promise);

    const result = execCommand("cmd", [], "/tmp");
    child.pid = 1234;
    ready = true;
    spawned.resolve();
    await spawned.promise;
    stdout.emit("data", Buffer.from("stdout-after-spawn"));
    stderr.emit("data", Buffer.from("stderr-after-spawn"));
    completion.resolve(0);

    await expect(result).resolves.toMatchObject({
      code: 0,
      stdout: "stdout-after-spawn",
      stderr: "stderr-after-spawn",
    });
  });

  it("honors caller-supplied small output caps", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    completionMock.mockReturnValue(wait.promise);

    const resultPromise = execCommand("cmd", [], "/tmp", { maxOutputChars: 3 });
    child.stdout.emit("data", Buffer.from("abcdef"));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("def");
    expect(result.stdoutTruncatedChars).toBe(3);
  });

  it("keeps caller-capped retained output UTF-16 safe", async () => {
    const { child, wait, resultPromise } = startCommand({ maxOutputChars: 2 });
    child.stdout.emit("data", Buffer.from("A😀B"));
    child.stderr.emit("data", Buffer.from("C😀D"));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.stdout).toBe("B");
    expect(result.stderr).toBe("D");
    expect(result.stdoutTruncatedChars).toBe(3);
    expect(result.stderrTruncatedChars).toBe(3);
  });

  it("fails instead of silently truncating default exec output", async () => {
    const { child, wait, resultPromise } = startCommand();
    child.stdout.emit("data", Buffer.from(`${"x".repeat(16 * 1024 * 1024 - 1)}😀`));
    wait.resolve(0);

    const result = await resultPromise;
    expect(terminateMock).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(result.code).toBe(1);
    expect(result.killed).toBe(true);
    expect(result.outputLimitExceeded).toBe("stdout");
    expect(result.stdout.length).toBe(16 * 1024 * 1024 - 1);
    expect(result.stdout.endsWith("x")).toBe(true);
    expect(result.stdoutTruncatedChars).toBe(2);
    expect(result.stderr).toContain("exec stdout exceeded output limit");
  });

  it.each(["abort", "timeout"] as const)(
    "settles %s while startup is pending and retains cleanup for a late process",
    async (reason) => {
      vi.useFakeTimers();
      const child = createStubChild();
      child.pid = undefined;
      const started = createDeferred();
      const completion = createDeferred<number | null>();
      const controller = new AbortController();
      spawnMock.mockReturnValue(child);
      completionMock.mockReturnValue(completion.promise);
      waitForSpawnMock.mockReturnValue(started.promise);
      const result = execCommand("cmd", [], "/tmp", {
        signal: controller.signal,
        ...(reason === "timeout" ? { timeout: 10 } : {}),
      });
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
        expect(spawnMock.mock.calls[0]?.[1].cancelSignal.aborted).toBe(true);
        expect(createTerminationControllerMock).not.toHaveBeenCalled();
        child.pid = 1234;
        started.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(terminateMock).toHaveBeenCalledOnce();
        completion.resolve(null);
        await vi.advanceTimersByTimeAsync(0);
        expect(settleTerminationMock).toHaveBeenCalledOnce();
      } finally {
        child.pid = 1234;
        started.resolve();
        completion.resolve(null);
        await result;
      }
    },
  );

  it("does not resolve a killed command until process-tree cleanup settles", async () => {
    vi.useFakeTimers();
    const cleanup = createDeferred();
    settleTerminationMock.mockReturnValue(cleanup.promise);
    const { wait, resultPromise } = startCommand({ timeout: 10 });
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
    const { child, wait, resultPromise } = startCommand();
    child.stdout.emit("error", new Error("EPIPE"));
    child.stderr.emit("error", new Error("EIO"));
    wait.resolve(0);

    await expect(resultPromise).resolves.toMatchObject({ code: 0 });
  });
});
