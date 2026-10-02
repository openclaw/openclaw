import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FaceTimeHelperSupervisor } from "../src/helper-supervisor.js";

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

describe("FaceTime helper supervisor", () => {
  let activeSupervisor: FaceTimeHelperSupervisor;
  function createSupervisor(overrides: Partial<SupervisorParams> = {}) {
    activeSupervisor = new FaceTimeHelperSupervisor({
      pluginRoot: "/tmp/facetime",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runCommandWithTimeout: vi
        .fn<SupervisorParams["runCommandWithTimeout"]>()
        .mockResolvedValue(completed),
      connectedBundles: () => [],
      targetAvailable: () => true,
      initialGraceMs: 0,
      retryDelaysMs: [1_000],
      connectionGraceMs: 0,
      ...overrides,
    });
    return activeSupervisor;
  }
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await activeSupervisor.stop();
    vi.useRealTimers();
  });

  it("reports the second serialized injection as queued", async () => {
    const { promise: firstInjection, resolve: finishFirst } =
      Promise.withResolvers<CommandResult>();
    const runCommandWithTimeout = vi
      .fn<SupervisorParams["runCommandWithTimeout"]>()
      .mockReturnValueOnce(firstInjection)
      .mockResolvedValue(completed);
    const supervisor = createSupervisor({ runCommandWithTimeout, initialGraceMs: 100 });

    supervisor.start();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);

    expect(supervisor.status()).toEqual([
      expect.objectContaining({ target: "FaceTime", injecting: true, queued: false }),
      expect.objectContaining({ target: "Phone", injecting: false, queued: true }),
    ]);

    finishFirst(completed);
    await firstInjection;
    await vi.advanceTimersByTimeAsync(0);
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(2);
    for (const [index, target] of ["FaceTime", "Phone"].entries()) {
      expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
        index + 1,
        ["/bin/bash", "/tmp/facetime/scripts/inject-helper.sh", "--app", target],
        expect.objectContaining({
          timeoutMs: 120_000,
          killProcessTree: true,
          signal: expect.any(AbortSignal),
        }),
      );
    }
  });

  it("cancels reinjection after an authenticated helper reconnects", async () => {
    const connectedBundles: string[] = [];
    const runCommandWithTimeout = vi
      .fn<SupervisorParams["runCommandWithTimeout"]>()
      .mockResolvedValue(completed);
    const supervisor = createSupervisor({
      runCommandWithTimeout,
      connectedBundles: () => connectedBundles,
      initialGraceMs: 100,
    });

    supervisor.start();
    connectedBundles.push("com.apple.FaceTime", "com.apple.mobilephone");
    supervisor.connected("com.apple.FaceTime");
    supervisor.connected("com.apple.mobilephone");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(supervisor.status()).toEqual([
      expect.objectContaining({ target: "FaceTime", connected: true, attempts: 0 }),
      expect.objectContaining({ target: "Phone", connected: true, attempts: 0 }),
    ]);
  });

  it("backs off and reports the last injection failure", async () => {
    const runCommandWithTimeout = vi
      .fn<SupervisorParams["runCommandWithTimeout"]>()
      .mockResolvedValue({
        ...completed,
        code: 1,
        stdout: "",
        stderr: "Developer Tools mode is disabled",
      });
    const supervisor = createSupervisor({
      runCommandWithTimeout,
      connectedBundles: () => ["com.apple.mobilephone"],
      retryDelaysMs: [1_000, 5_000],
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
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
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("reports an injection that never authenticates instead of waiting forever", async () => {
    const runCommandWithTimeout = vi
      .fn<SupervisorParams["runCommandWithTimeout"]>()
      .mockResolvedValue(completed);
    const supervisor = createSupervisor({
      runCommandWithTimeout,
      targetAvailable: (target) => target === "FaceTime",
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

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

  it("does not supervise Phone when the app is unavailable", async () => {
    const runCommandWithTimeout = vi
      .fn<SupervisorParams["runCommandWithTimeout"]>()
      .mockResolvedValue(completed);
    const supervisor = createSupervisor({
      runCommandWithTimeout,
      targetAvailable: (target) => target === "FaceTime",
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/bash", "/tmp/facetime/scripts/inject-helper.sh", "--app", "FaceTime"],
      expect.objectContaining({
        timeoutMs: 120_000,
        killProcessTree: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(supervisor.status().map((entry) => entry.target)).toEqual(["FaceTime"]);
  });

  it("waits for a stale helper process to exit before reinjecting", async () => {
    let processAlive = true;
    const runCommandWithTimeout = vi
      .fn<SupervisorParams["runCommandWithTimeout"]>()
      .mockResolvedValue(completed);
    const supervisor = createSupervisor({
      runCommandWithTimeout,
      processAlive: () => processAlive,
      initialGraceMs: 10_000,
    });

    supervisor.start();
    supervisor.stale("com.apple.FaceTime", 1234);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(supervisor.status()).toContainEqual(
      expect.objectContaining({
        target: "FaceTime",
        stale: true,
        staleProcessId: 1234,
      }),
    );

    processAlive = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/bash", "/tmp/facetime/scripts/inject-helper.sh", "--app", "FaceTime"],
      expect.objectContaining({ timeoutMs: 120_000, killProcessTree: true }),
    );
  });

  it("warns once while stale helper processes keep reconnecting", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const supervisor = createSupervisor({
      logger,
      targetAvailable: (target) => target === "FaceTime",
      processAlive: () => true,
      initialGraceMs: 10_000,
    });

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
      expect.objectContaining({
        target: "FaceTime",
        staleProcessId: 5678,
      }),
    );

    supervisor.connected("com.apple.FaceTime");
    supervisor.stale("com.apple.FaceTime", 9012);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("preserves the stale-process monitor when injection finishes concurrently", async () => {
    const { promise: firstInjection, resolve: finishInjection } =
      Promise.withResolvers<CommandResult>();
    const runCommandWithTimeout = vi
      .fn<SupervisorParams["runCommandWithTimeout"]>()
      .mockReturnValueOnce(firstInjection)
      .mockResolvedValue(completed);
    const supervisor = createSupervisor({
      runCommandWithTimeout,
      targetAvailable: (target) => target === "FaceTime",
      processAlive: () => false,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);

    supervisor.stale("com.apple.FaceTime", 1234);
    finishInjection(completed);
    await firstInjection;
    await vi.advanceTimersByTimeAsync(2_001);

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("aborts and joins in-flight LLDB injection before stop completes", async () => {
    let injectionSignal: AbortSignal | undefined;
    const runCommandWithTimeout = vi.fn<SupervisorParams["runCommandWithTimeout"]>(
      async (_argv, options) => {
        if (typeof options === "number" || !options.signal) {
          throw new Error("injection must be cancellable");
        }
        const signal = options.signal;
        injectionSignal = signal;
        return await new Promise<CommandResult>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ ...completed, code: 1, stderr: "aborted" }),
            { once: true },
          );
        });
      },
    );
    const supervisor = createSupervisor({
      runCommandWithTimeout,
    });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();

    await supervisor.stop();
    expect(injectionSignal?.aborted).toBe(true);
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
    expect(runCommandWithTimeout.mock.calls[0]?.[1]).toMatchObject({
      killProcessTree: true,
    });
  });
});
