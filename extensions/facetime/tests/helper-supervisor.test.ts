import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";
import { FaceTimeHelperSupervisor } from "../src/helper-supervisor.js";

vi.mock("node:fs", () => ({ existsSync: vi.fn() }));

type SupervisorParams = ConstructorParameters<typeof FaceTimeHelperSupervisor>[0];
const completed = commandResult();
const processExited = () => {
  throw Object.assign(new Error("process exited"), { code: "ESRCH" });
};

let supervisor: FaceTimeHelperSupervisor;
let bundles: string[];
const run = vi.fn<SupervisorParams["runCommandWithTimeout"]>();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
function expectStatus(expected: Partial<ReturnType<FaceTimeHelperSupervisor["status"]>[number]>) {
  expect(supervisor.status()[0]).toMatchObject({ target: "FaceTime", ...expected });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  run.mockReset().mockResolvedValue(completed);
  bundles = [];
  vi.mocked(existsSync).mockImplementation((path) => path === "/System/Applications/FaceTime.app");
  vi.spyOn(process, "kill").mockReturnValue(true);
  supervisor = new FaceTimeHelperSupervisor({
    pluginRoot: "/tmp/facetime",
    logger,
    runCommandWithTimeout: run,
    connectedBundles: () => bundles,
  });
});
afterEach(async () => {
  await supervisor.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("cancels reinjection after an authenticated helper reconnects", async () => {
  supervisor.start();
  bundles.push("com.apple.FaceTime", "com.apple.mobilephone");
  supervisor.connected("com.apple.FaceTime");
  supervisor.connected("com.apple.mobilephone");
  await vi.advanceTimersByTimeAsync(6_000);

  expect(run).not.toHaveBeenCalled();
  expectStatus({ connected: true, attempts: 0 });
});

it.each([
  [commandResult({ code: 1, stderr: "injection failed" }), 6_000, "injection failed"],
  [
    completed,
    16_000,
    "FaceTime helper injection completed but no authenticated connection arrived",
  ],
] as const)(
  "backs off and reports injection failure after %j",
  async (result, delay, lastError) => {
    bundles.push("com.apple.mobilephone");
    run.mockResolvedValue(result);
    supervisor.start();
    await vi.advanceTimersByTimeAsync(delay);
    expectStatus({ lastError, injecting: false });
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  },
);

it("warns once per stale episode and waits for process exit before reinjecting", async () => {
  supervisor.start();
  supervisor.stale("com.apple.FaceTime", 1234);
  supervisor.stale("com.apple.FaceTime", 1234);
  supervisor.stale("com.apple.FaceTime.FTConversationService", 1234);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expectStatus({ stale: true, staleProcessId: 1234, retryScheduled: true });
  supervisor.stale("com.apple.FaceTime", 5678);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expectStatus({ staleProcessId: 5678 });
  supervisor.connected("com.apple.FaceTime");
  supervisor.stale("com.apple.FaceTime", 9012);
  expect(logger.warn).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(run).not.toHaveBeenCalled();
  expectStatus({ stale: true, staleProcessId: 9012 });
  vi.spyOn(process, "kill").mockImplementation(processExited);
  await vi.advanceTimersByTimeAsync(2_001);
  expect(run).toHaveBeenCalledOnce();
});

it("preserves the stale-process monitor when injection finishes concurrently", async () => {
  const { promise, resolve } = Promise.withResolvers<typeof completed>();
  vi.spyOn(process, "kill").mockImplementation(processExited);
  run.mockReturnValueOnce(promise);
  supervisor.start();
  await vi.advanceTimersByTimeAsync(6_000);
  supervisor.stale("com.apple.FaceTime", 1234);
  resolve(completed);
  await promise;
  await vi.advanceTimersByTimeAsync(2_001);
  expect(run).toHaveBeenCalledTimes(2);
});

it("aborts and joins in-flight LLDB injection before stop completes", async () => {
  let injectionSignal: AbortSignal | undefined;
  const { promise, resolve } = Promise.withResolvers<typeof completed>();
  run.mockImplementation(async (_argv, options) => {
    if (typeof options === "number" || !options.signal) {
      throw new Error("injection must be cancellable");
    }
    injectionSignal = options.signal;
    options.signal.addEventListener(
      "abort",
      () => resolve({ ...completed, code: 1, stderr: "aborted" }),
      { once: true },
    );
    return await promise;
  });
  supervisor.start();
  await vi.advanceTimersByTimeAsync(6_000);
  await supervisor.stop();
  expect(injectionSignal?.aborted).toBe(true);
  expect(run.mock.calls[0]?.[1]).toMatchObject({ killProcessTree: true });
});
