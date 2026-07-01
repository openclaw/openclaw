// execCommand tests cover child-process output retention, limits, and timeout
// termination semantics used by agent sessions.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { killProcessTreeAndWaitMock, spawnMock, waitForChildProcessMock } = vi.hoisted(() => ({
  killProcessTreeAndWaitMock: vi.fn(),
  spawnMock: vi.fn(),
  waitForChildProcessMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../utils/child-process.js", () => ({
  waitForChildProcess: waitForChildProcessMock,
}));

vi.mock("../../process/kill-tree.js", () => ({
  killProcessTreeAndWait: killProcessTreeAndWaitMock,
}));

type StubChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
  stderr: EventEmitter;
  stdout: EventEmitter;
};

function createStubChild(): StubChild {
  const child = new EventEmitter() as StubChild;
  child.pid = 1234;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("execCommand", () => {
  beforeEach(() => {
    killProcessTreeAndWaitMock.mockReset();
    killProcessTreeAndWaitMock.mockResolvedValue(undefined);
    spawnMock.mockReset();
    waitForChildProcessMock.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("bounds retained stdout and stderr independently", async () => {
    // stdout and stderr are separate buffers; a noisy stream must not evict the
    // diagnostic tail from the other stream.
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp", { maxOutputChars: 256 });
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

  it("spawns commands with process-tree cleanup options", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", ["arg"], "/tmp");
    wait.resolve(0);
    await resultPromise;

    expect(spawnMock).toHaveBeenCalledWith("cmd", ["arg"], {
      cwd: "/tmp",
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  });

  it("honors caller-supplied small output caps", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp", { maxOutputChars: 3 });
    child.stdout.emit("data", Buffer.from("abcdef"));
    wait.resolve(0);

    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("def");
    expect(result.stdoutTruncatedChars).toBe(3);
  });

  it("fails instead of silently truncating default exec output", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp");
    child.stdout.emit("data", Buffer.from("x".repeat(16 * 1024 * 1024 + 1)));
    wait.resolve(0);

    const result = await resultPromise;
    expect(killProcessTreeAndWaitMock).toHaveBeenCalledWith(1234, {
      detached: process.platform !== "win32",
      graceMs: 5000,
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(result.code).toBe(1);
    expect(result.killed).toBe(true);
    expect(result.outputLimitExceeded).toBe("stdout");
    expect(result.stdout.length).toBe(16 * 1024 * 1024);
    expect(result.stdoutTruncatedChars).toBe(1);
    expect(result.stderr).toContain("exec stdout exceeded output limit");
  });

  it("terminates timed-out commands through the process-tree killer", async () => {
    // Extension exec uses the same tree-kill boundary as the built-in shell so
    // timed-out wrappers do not leave descendant processes running.
    vi.useFakeTimers();
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp", { timeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(killProcessTreeAndWaitMock).toHaveBeenCalledWith(1234, {
      detached: process.platform !== "win32",
      graceMs: 5000,
    });
    expect(child.kill).not.toHaveBeenCalled();

    wait.resolve(null);
    const result = await resultPromise;
    expect(result.killed).toBe(true);
  });

  it("waits for process-tree cleanup before resolving killed output-limit results", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    const cleanup = createDeferred<void>();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockReturnValue(wait.promise);
    killProcessTreeAndWaitMock.mockReturnValue(cleanup.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp");
    child.stdout.emit("data", Buffer.from("x".repeat(16 * 1024 * 1024 + 1)));
    wait.resolve(0);
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(resolved).toBe(false);
    cleanup.resolve();
    const result = await resultPromise;
    expect(result.killed).toBe(true);
    expect(result.outputLimitExceeded).toBe("stdout");
  });

  it("terminates aborted commands through the process-tree killer", async () => {
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    const controller = new AbortController();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp", { signal: controller.signal });
    controller.abort();
    wait.resolve(null);

    const result = await resultPromise;
    expect(killProcessTreeAndWaitMock).toHaveBeenCalledWith(1234, {
      detached: process.platform !== "win32",
      graceMs: 5000,
    });
    expect(result.killed).toBe(true);
  });

  it("falls back to direct child kill when abort races a pid-less spawn failure", async () => {
    const child = createStubChild();
    delete child.pid;
    const controller = new AbortController();
    controller.abort();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockRejectedValue(new Error("spawn failed"));
    const { execCommand } = await import("./exec.js");

    const result = await execCommand("cmd", [], "/tmp", { signal: controller.signal });

    expect(killProcessTreeAndWaitMock).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result).toMatchObject({ code: 1, killed: true });
  });

  it("starts cleanup once when output overflow, abort, and timeout race", async () => {
    vi.useFakeTimers();
    const child = createStubChild();
    const wait = createDeferred<number | null>();
    const controller = new AbortController();
    spawnMock.mockReturnValue(child);
    waitForChildProcessMock.mockReturnValue(wait.promise);
    const { execCommand } = await import("./exec.js");

    const resultPromise = execCommand("cmd", [], "/tmp", {
      signal: controller.signal,
      timeout: 10,
    });
    child.stdout.emit("data", Buffer.from("x".repeat(16 * 1024 * 1024 + 1)));
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    wait.resolve(null);

    const result = await resultPromise;
    expect(killProcessTreeAndWaitMock).toHaveBeenCalledTimes(1);
    expect(result.killed).toBe(true);
    expect(result.outputLimitExceeded).toBe("stdout");
  });
});
