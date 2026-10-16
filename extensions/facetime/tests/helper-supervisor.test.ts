import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FaceTimeHelperSupervisor } from "../src/helper-supervisor.js";

vi.mock("node:fs", () => ({ existsSync: vi.fn() }));

type SupervisorParams = ConstructorParameters<typeof FaceTimeHelperSupervisor>[0];
type CommandResult = Awaited<ReturnType<SupervisorParams["runCommandWithTimeout"]>>;
const completed: CommandResult = {
  code: 0,
  stdout: "",
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit",
};
const injection = (target = "FaceTime") => [
  "/bin/bash",
  "/tmp/facetime/scripts/inject-helper.sh",
  "--app",
  target,
];
const cancellable = { timeoutMs: 120_000, killProcessTree: true, signal: expect.any(AbortSignal) };

describe("FaceTime helper supervisor", () => {
  let activeSupervisor: FaceTimeHelperSupervisor;
  function createSupervisor(overrides: Partial<SupervisorParams> = {}) {
    const run = vi.fn<SupervisorParams["runCommandWithTimeout"]>().mockResolvedValue(completed);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    activeSupervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger,
      runCommandWithTimeout: run,
      connectedBundles: () => [],
      ...overrides,
    });
    return { supervisor: activeSupervisor, run, logger };
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.spyOn(process, "kill").mockReturnValue(true);
  });
  afterEach(async () => {
    await activeSupervisor.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cancels reinjection after an authenticated helper reconnects", async () => {
    const connectedBundles: string[] = [];
    const runCommandWithTimeout = vi
      .fn<SupervisorParams["runCommandWithTimeout"]>()
      .mockResolvedValue(completed);
    const { supervisor } = createSupervisor({
      runCommandWithTimeout,
      connectedBundles: () => connectedBundles,
    });

    supervisor.start();
    connectedBundles.push("com.apple.FaceTime", "com.apple.mobilephone");
    supervisor.connected("com.apple.FaceTime");
    supervisor.connected("com.apple.mobilephone");
    await vi.advanceTimersByTimeAsync(6_000);

    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(supervisor.status()).toEqual([
      expect.objectContaining({ target: "FaceTime", connected: true, attempts: 0 }),
      expect.objectContaining({ target: "Phone", connected: true, attempts: 0 }),
    ]);
  });

  it("backs off and reports the last injection failure", async () => {
    const { supervisor, run } = createSupervisor({
      connectedBundles: () => ["com.apple.mobilephone"],
    });
    run.mockResolvedValue({ ...completed, code: 1, stderr: "Developer Tools mode is disabled" });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(supervisor.status()).toContainEqual(
      expect.objectContaining({
        target: "FaceTime",
        attempts: 1,
        connected: false,
        injecting: false,
        lastError: "Developer Tools mode is disabled",
      }),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports an injection that never authenticates instead of waiting forever", async () => {
    vi.mocked(existsSync).mockImplementation(
      (path) => path === "/System/Applications/FaceTime.app",
    );
    const runCommandWithTimeout = vi
      .fn<SupervisorParams["runCommandWithTimeout"]>()
      .mockResolvedValue(completed);
    const { supervisor } = createSupervisor({
      runCommandWithTimeout,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(16_000);

    expect(supervisor.status()).toContainEqual(
      expect.objectContaining({
        target: "FaceTime",
        connected: false,
        injecting: false,
        retryScheduled: true,
        lastError: "FaceTime helper injection completed but no authenticated connection arrived",
      }),
    );
  });

  it("waits for a stale helper process to exit before reinjecting", async () => {
    const { supervisor, run } = createSupervisor();
    supervisor.start();
    supervisor.stale("com.apple.FaceTime", 1234);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).not.toHaveBeenCalled();
    expect(supervisor.status()).toContainEqual(
      expect.objectContaining({
        target: "FaceTime",
        stale: true,
        staleProcessId: 1234,
      }),
    );
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(run).toHaveBeenCalledWith(injection(), expect.objectContaining(cancellable));
  });

  it("warns once while stale helper processes keep reconnecting", () => {
    vi.mocked(existsSync).mockImplementation(
      (path) => path === "/System/Applications/FaceTime.app",
    );
    const { supervisor, logger } = createSupervisor();
    supervisor.start();
    supervisor.stale("com.apple.FaceTime", 1234);
    supervisor.stale("com.apple.FaceTime", 1234);
    supervisor.stale("com.apple.FaceTime.FTConversationService", 1234);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      "[facetime] Restart FaceTime to load the updated OpenClaw helper",
    );
    expect(supervisor.status()).toContainEqual(
      expect.objectContaining({
        target: "FaceTime",
        stale: true,
        staleProcessId: 1234,
        retryScheduled: true,
      }),
    );
    supervisor.stale("com.apple.FaceTime", 5678);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(supervisor.status()).toContainEqual(
      expect.objectContaining({ target: "FaceTime", staleProcessId: 5678 }),
    );
    supervisor.connected("com.apple.FaceTime");
    supervisor.stale("com.apple.FaceTime", 9012);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("preserves the stale-process monitor when injection finishes concurrently", async () => {
    const { promise, resolve } = Promise.withResolvers<CommandResult>();
    vi.mocked(existsSync).mockImplementation(
      (path) => path === "/System/Applications/FaceTime.app",
    );
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    });
    const { supervisor, run } = createSupervisor();
    run.mockReturnValueOnce(promise);
    supervisor.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run).toHaveBeenCalledTimes(1);
    supervisor.stale("com.apple.FaceTime", 1234);
    resolve(completed);
    await promise;
    await vi.advanceTimersByTimeAsync(2_001);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("aborts and joins in-flight LLDB injection before stop completes", async () => {
    let injectionSignal: AbortSignal | undefined;
    const { supervisor, run } = createSupervisor();
    run.mockImplementation(async (_argv, options) => {
      if (typeof options === "number" || !options.signal) {
        throw new Error("injection must be cancellable");
      }
      injectionSignal = options.signal;
      return await new Promise<CommandResult>((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => resolve({ ...completed, code: 1, stderr: "aborted" }),
          { once: true },
        );
      });
    });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run).toHaveBeenCalledOnce();
    await supervisor.stop();
    expect(injectionSignal?.aborted).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).toMatchObject({ killProcessTree: true });
  });
});
