import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { createStubChildAdapter } from "../process/supervisor/supervisor.test-support.js";
import { getFinishedSession, markBackgrounded } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

const createChildAdapterMock = vi.hoisted(() => vi.fn());
// mock-isolation: Controlled adapters expose finalization and extinction without spawning children.
vi.mock("../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: createChildAdapterMock,
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisor,
}));

let supervisor: ReturnType<typeof createProcessSupervisor>;

afterEach(async () => {
  await supervisor.shutdown();
  resetProcessRegistryForTests();
  vi.restoreAllMocks();
});

it("retains output time through finalization after 2,000 other processes complete", async () => {
  supervisor = createProcessSupervisor();
  createChildAdapterMock.mockReset();
  resetProcessRegistryForTests();
  const { createProcessTool } = await import("./bash-tools.process.js");
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const finalizing = createDeferred();
  const finalize = createDeferred();
  const extinction = createDeferred();
  const adapter = createStubChildAdapter({
    onKill: (signal, current) => current.settle(null, signal),
  });
  adapter.waitForExtinction = () => extinction.promise;
  createChildAdapterMock
    .mockResolvedValueOnce({ adapter, ready: Promise.resolve() })
    .mockImplementation(async () => {
      const other = createStubChildAdapter();
      other.settle(0);
      return { adapter: other, ready: Promise.resolve() };
    });
  const run = await runExecProcess({
    command: "interactive-command",
    workdir: process.cwd(),
    env: {},
    usePty: false,
    warnings: [],
    maxOutput: 1_000,
    pendingMaxOutput: 1_000,
    notifyOnExit: false,
    timeoutSec: null,
    sandbox: {
      containerName: "activity-fixture",
      workspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
      buildExecSpec: async () => ({ argv: ["fixture"], env: {}, stdinMode: "pipe-open" }),
      finalizeExec: async () => {
        finalizing.resolve();
        await finalize.promise;
      },
    },
  });
  markBackgrounded(run.session);
  const processTool = createProcessTool();
  try {
    adapter.emitStdout("Name? ");
    now.mockReturnValue(21_000);
    // Sanitized-away terminal output still belongs to the real output producer.
    adapter.emitStderr("\u001b[31m");
    adapter.settle(0);
    await finalizing.promise;
    now.mockReturnValue(26_000);
    expect(run.session.exited).toBe(false);
    expect(adapter.disposeMock).not.toHaveBeenCalled();

    // The old diagnostic history evicted this finalizing exec on the 2,000th unrelated exit.
    for (let index = 0; index < 2_000; index += 1) {
      const other = await supervisor.spawn({ mode: "child", argv: ["fixture"] });
      await other.wait();
    }
    const log = await processTool.execute("log", { action: "log", sessionId: run.session.id });
    expect(log.details).toMatchObject({ lastOutputAt: 21_000, idleMs: 5_000 });
    expect(run.session.finalizing).toBe(true);
  } finally {
    extinction.resolve();
    finalize.resolve();
    await run.promise;
  }
  const finished = getFinishedSession(run.session.id);
  expect(finished).toMatchObject({ exited: true, exitCode: 0, aggregated: "Name? " });
  expect(run.session).not.toHaveProperty("processActivity");
  expect(adapter.disposeMock).toHaveBeenCalledOnce();
});
