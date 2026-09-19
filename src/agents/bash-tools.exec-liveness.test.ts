import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
  resolveRunStaleThresholdMs,
  startDiagnosticRunActivityTracking,
} from "../logging/diagnostic-run-activity.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { SpawnProcessAdapter } from "../process/supervisor/types.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";

const mocks = vi.hoisted(() => ({
  getSupervisor: vi.fn(),
  createChildAdapter: vi.fn(),
  approve: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: mocks.getSupervisor }));
vi.mock("../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: async (
    ...args: Parameters<typeof import("../process/supervisor/adapters/child.js").createChildAdapter>
  ) => ({
    adapter: await mocks.createChildAdapter(...args),
    ready: Promise.resolve(),
  }),
}));
vi.mock("../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: () => null,
  resolveShellEnvFallbackTimeoutMs: () => 0,
}));
vi.mock("./bash-tools.exec-host-gateway.js", () => ({ processGatewayAllowlist: mocks.approve }));

function createAdapter() {
  const completed = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const kill = vi.fn((signal?: NodeJS.Signals) => {
    completed.resolve({ code: null, signal: signal ?? "SIGTERM" });
  });
  const adapter: SpawnProcessAdapter = {
    supportsRawOutput: true,
    onStdout: () => undefined,
    onStderr: () => undefined,
    wait: () => completed.promise,
    kill,
    dispose: () => undefined,
  };
  return { adapter, kill, completed };
}

function createWrappedExec(sessionId: string, allowBackground = false) {
  const ref = { sessionId, sessionKey: `agent:main:${sessionId}`, runId: `run-${sessionId}` };
  const tool = wrapToolWithBeforeToolCallHook(
    createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      notifyOnExit: false,
      allowBackground,
    }),
    ref,
  );
  return { tool, ref };
}

describe("registered exec deadline handoff", () => {
  let supervisor: ReturnType<typeof createProcessSupervisor>;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0");
    mocks.createChildAdapter.mockReset();
    mocks.approve.mockReset().mockResolvedValue({});
    supervisor = createProcessSupervisor();
    mocks.getSupervisor.mockReturnValue(supervisor);
    setDiagnosticsEnabledForProcess(true);
    startDiagnosticRunActivityTracking();
  });

  afterEach(async () => {
    await supervisor.shutdown();
    resetProcessRegistryForTests();
    resetDiagnosticRunActivityForTest();
    resetDiagnosticEventsForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses the supervisor deadline after preparation and returns its timeout as a tool result", async () => {
    const preparation = createDeferred<object>();
    const preparing = createDeferred();
    mocks.approve.mockImplementationOnce(() => {
      preparing.resolve();
      return preparation.promise;
    });
    const child = createAdapter();
    const spawned = createDeferred();
    mocks.createChildAdapter.mockImplementationOnce(async () => {
      spawned.resolve();
      return child.adapter;
    });
    const spawn = vi.spyOn(supervisor, "spawn");
    const { tool, ref } = createWrappedExec("prepared-deadline");
    const execution = tool.execute("foreground", { command: "sleep 970", timeoutSeconds: 1400 });
    await preparing.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs).toBeUndefined();

    const processStartedAt = Date.now();
    preparation.resolve({});
    await spawned.promise;
    await spawn.mock.results[0]?.value;
    await vi.advanceTimersByTimeAsync(0);
    const deadline = processStartedAt + 1_400_000;
    const recoveryDeadline = deadline + BLOCKED_TOOL_CALL_ABORT_FLOOR_MS;
    expect(getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs).toBe(recoveryDeadline);

    await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS + 1);
    const snapshot = getDiagnosticSessionActivitySnapshot(ref);
    expect(snapshot.activeToolDeadlineAtMs).toBe(recoveryDeadline);
    expect(resolveRunStaleThresholdMs(snapshot)).toBeGreaterThan(snapshot.lastProgressAgeMs!);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(deadline - Date.now());
    const result = await execution;
    expect(result.details).toMatchObject({ status: "failed", failureKind: "overall-timeout" });
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs).toBeUndefined();
  });

  it("keeps timeout cleanup local and bounds a cancellation that never settles", async () => {
    const child = createAdapter();
    child.kill.mockImplementation(() => undefined);
    const spawned = createDeferred();
    mocks.createChildAdapter.mockImplementationOnce(async () => {
      spawned.resolve();
      return child.adapter;
    });
    const spawn = vi.spyOn(supervisor, "spawn");
    const { tool, ref } = createWrappedExec("timeout-cleanup");
    const execution = tool.execute("timeout", { command: "sleep 3600", timeoutSeconds: 300 });
    await spawned.promise;
    await spawn.mock.results[0]?.value;
    await waitForDiagnosticEventsDrained();
    await vi.advanceTimersByTimeAsync(300_001);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    const duringCleanup = getDiagnosticSessionActivitySnapshot(ref);
    expect(resolveRunStaleThresholdMs(duringCleanup)).toBeGreaterThan(
      duringCleanup.lastProgressAgeMs!,
    );

    await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS);
    const hungCleanup = getDiagnosticSessionActivitySnapshot(ref);
    expect(resolveRunStaleThresholdMs(hungCleanup)).toBeLessThan(hungCleanup.lastProgressAgeMs!);
    child.completed.resolve({ code: null, signal: "SIGKILL" });
    await expect(execution).resolves.toMatchObject({
      details: { status: "failed", failureKind: "overall-timeout" },
    });
  });

  it("keeps a no-deadline exec recoverable and honors explicit cancellation", async () => {
    const child = createAdapter();
    const spawned = createDeferred();
    mocks.createChildAdapter.mockImplementationOnce(async () => {
      spawned.resolve();
      return child.adapter;
    });
    const spawn = vi.spyOn(supervisor, "spawn");
    const { tool, ref } = createWrappedExec("no-deadline");
    const controller = new AbortController();
    const execution = tool.execute(
      "hung",
      { command: "sleep 3600", timeoutSeconds: 0 },
      controller.signal,
    );
    await spawned.promise;
    await spawn.mock.results[0]?.value;
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS + 1);
    const snapshot = getDiagnosticSessionActivitySnapshot(ref);
    expect(snapshot.activeToolDeadlineAtMs).toBeUndefined();
    expect(resolveRunStaleThresholdMs(snapshot)).toBeLessThan(snapshot.lastProgressAgeMs!);
    const aborted = expect(execution).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await aborted;
    expect(child.kill).toHaveBeenCalled();
  });

  it("releases foreground liveness when exec backgrounds without removing its process timeout", async () => {
    const child = createAdapter();
    mocks.createChildAdapter.mockResolvedValueOnce(child.adapter);
    const { tool, ref } = createWrappedExec("background-deadline", true);
    const controller = new AbortController();
    const result = await tool.execute(
      "background",
      { command: "sleep 30", timeoutSeconds: 1, background: true },
      controller.signal,
    );
    expect(result.details).toMatchObject({ status: "running" });
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs).toBeUndefined();
    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
