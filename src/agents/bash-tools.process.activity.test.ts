import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { createStubChildAdapter } from "../process/supervisor/supervisor.test-support.js";
import { cancelBackgroundExecSession } from "./bash-process-control.js";
import { getFinishedSession, markBackgrounded, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

const { createChildAdapterMock } = vi.hoisted(() => ({
  createChildAdapterMock: vi.fn(),
}));
vi.mock("../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: async (
    ...args: Parameters<typeof import("../process/supervisor/adapters/child.js").createChildAdapter>
  ) => ({
    adapter: await createChildAdapterMock(...args),
    ready: Promise.resolve(),
  }),
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisor,
}));

let supervisor: ReturnType<typeof createProcessSupervisor>;

beforeEach(() => {
  supervisor = createProcessSupervisor();
  createChildAdapterMock.mockReset();
  resetProcessRegistryForTests();
});

afterEach(async () => {
  await supervisor.shutdown();
  resetProcessRegistryForTests();
  vi.restoreAllMocks();
});

describe("background process activity ownership", () => {
  it("retains output time through finalization after 2,000 other processes complete", async () => {
    const { createProcessTool } = await import("./bash-tools.process.js");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const finalizing = createDeferred();
    const finalize = createDeferred();
    const extinction = createDeferred();
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => current.settle(null, signal),
    });
    adapter.stdin = { write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
    adapter.waitForExtinction = () => extinction.promise;
    createChildAdapterMock.mockResolvedValueOnce(adapter).mockImplementation(async () => {
      const other = createStubChildAdapter();
      other.settle(0);
      return other;
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
      expect(run.session.finalizing).toBe(true);
      expect(run.session.exited).toBe(false);
      expect(adapter.disposeMock).not.toHaveBeenCalled();
      expect(cancelBackgroundExecSession(run.session.id)).toBe(false);
      expect(adapter.killMock).not.toHaveBeenCalled();

      const log = () =>
        processTool.execute("activity-log", {
          action: "log",
          sessionId: run.session.id,
        });
      expect((await log()).details).toMatchObject({
        lastOutputAt: 21_000,
        idleMs: 5_000,
      });
      // The retired diagnostic history evicted this still-finalizing exec
      // on the 2,000th unrelated exit.
      const unrelatedInput = {
        mode: "child" as const,
        argv: ["fixture"],
      };
      for (let index = 0; index < 2_000; index += 1) {
        const other = await supervisor.spawn(unrelatedInput);
        await other.wait();
      }
      expect((await log()).details).toMatchObject({
        lastOutputAt: 21_000,
        idleMs: 5_000,
      });
      expect(run.session.finalizing).toBe(true);
    } finally {
      extinction.resolve();
      finalize.resolve();
      await run.promise;
    }
    expect(getFinishedSession(run.session.id)).toMatchObject({
      exited: true,
      exitCode: 0,
      aggregated: "Name? ",
    });
    expect(run.session).not.toHaveProperty("processActivity");
    expect(adapter.disposeMock).toHaveBeenCalledOnce();
  });
});

it("publishes coalesced exec activity and cleanup without durable writes or late events", async () => {
  const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
  const { installInMemoryTaskRegistryRuntime } =
    await import("../test-utils/task-registry-runtime.js");
  const { configureTaskRegistryRuntime } = await import("../tasks/task-registry.store.js");
  const { resetTaskRegistryForTests } = await import("../tasks/task-registry.test-support.js");
  const { mapTaskSummary } = await import("../gateway/server-methods/task-summary.js");
  const { createExecTool } = await import("./bash-tools.exec-run.js");
  await withOpenClawTestState({ layout: "home", scenario: "minimal" }, async ({ workspaceDir }) => {
    resetTaskRegistryForTests({ persist: false });
    const { taskStore } = installInMemoryTaskRegistryRuntime();
    const writes = vi.spyOn(taskStore, "upsertTaskWithDeliveryState");
    const observations: Pick<ReturnType<typeof mapTaskSummary>, "execution" | "updatedAt">[] = [];
    configureTaskRegistryRuntime({
      observers: {
        onEvent(event) {
          if (event.kind === "upserted") {
            const { execution, updatedAt } = mapTaskSummary(event.task);
            observations.push({ execution, updatedAt });
          }
        },
      },
    });
    const finalizing = createDeferred();
    const finalize = createDeferred();
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValueOnce(adapter);
    const sessionKey = "agent:main:task-activity";
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      notifyOnExit: false,
      sessionKey,
      scopeKey: sessionKey,
      sandbox: {
        containerName: "activity-fixture",
        workspaceDir,
        containerWorkdir: "/workspace",
        buildExecSpec: async () => ({ argv: ["fixture"], env: {}, stdinMode: "pipe-open" }),
        finalizeExec: async () => {
          finalizing.resolve();
          await finalize.promise;
        },
      },
    });
    try {
      const result = await tool.execute("background-activity", {
        command: "fixture",
        background: true,
      });
      expect(result.details.status).toBe("running");
      const durableSnapshot = taskStore.loadSnapshot();
      const durableTasks = [...durableSnapshot.tasks.values()];
      expect(durableTasks).toHaveLength(1);
      const durableUpdatedAt = durableTasks[0]?.lastEventAt;
      expect(durableUpdatedAt).toEqual(expect.any(Number));
      observations.length = 0;
      writes.mockClear();
      const outputAt = Date.now() + 1_000;
      vi.useFakeTimers();
      vi.setSystemTime(outputAt);
      adapter.emitStdout("first");
      adapter.emitStdout("second");
      // Even output stripped by terminal sanitization advances the producer clock.
      adapter.emitStderr("\u001b[31m");
      await vi.advanceTimersByTimeAsync(999);
      expect(observations).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(observations).toEqual([
        {
          execution: { state: "running", lastActivityAt: outputAt },
          updatedAt: durableUpdatedAt,
        },
      ]);
      expect(writes).not.toHaveBeenCalled();
      expect(taskStore.loadSnapshot()).toEqual(durableSnapshot);
      observations.length = 0;
      adapter.settle(0);
      await finalizing.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(observations).toEqual([
        {
          execution: {
            state: "waiting",
            wait: { kind: "external" },
            lastActivityAt: outputAt + 1_000,
          },
          updatedAt: durableUpdatedAt,
        },
      ]);
      expect(writes).not.toHaveBeenCalled();
      expect(taskStore.loadSnapshot()).toEqual(durableSnapshot);
      finalize.resolve();
      await waitForExecScope(sessionKey);
      expect(observations.at(-1)).toMatchObject({
        execution: { state: "finished" },
        updatedAt: outputAt + 2_000,
      });
      observations.length = 0;
      adapter.emitStdout("late");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(observations).toEqual([]);
    } finally {
      adapter.settle(0);
      finalize.resolve();
      await waitForExecScope(sessionKey);
      vi.useRealTimers();
      resetTaskRegistryForTests({ persist: false });
    }
  });
});
