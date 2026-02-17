import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  addSession,
  getFinishedSession,
  getSession,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessTool } from "./bash-tools.process.js";

const { supervisorMock } = vi.hoisted(() => ({
  supervisorMock: {
    spawn: vi.fn(),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  },
}));

const { killProcessTreeMock } = vi.hoisted(() => ({
  killProcessTreeMock: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisorMock,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: (...args: unknown[]) => killProcessTreeMock(...args),
}));

function createBackgroundSession(id: string, pid?: number): ProcessSession {
  return {
    id,
    command: "sleep 999",
    startedAt: Date.now(),
    cwd: "/tmp",
    maxOutputChars: 10_000,
    pendingMaxOutputChars: 30_000,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "",
    tail: "",
    pid,
    exited: false,
    exitCode: undefined,
    exitSignal: undefined,
    truncated: false,
    backgrounded: true,
  };
}

describe("process tool supervisor cancellation", () => {
  beforeEach(() => {
    supervisorMock.spawn.mockReset();
    supervisorMock.cancel.mockReset();
    supervisorMock.cancelScope.mockReset();
    supervisorMock.reconcileOrphans.mockReset();
    supervisorMock.getRecord.mockReset();
    killProcessTreeMock.mockReset();
  });

  afterEach(() => {
    resetProcessRegistryForTests();
  });

  it("routes kill through supervisor when run is managed", async () => {
    supervisorMock.getRecord.mockReturnValue({
      runId: "sess",
      state: "running",
    });
    addSession(createBackgroundSession("sess"));
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "kill",
      sessionId: "sess",
    });

    expect(supervisorMock.cancel).toHaveBeenCalledWith("sess", "manual-cancel");
    expect(getSession("sess")).toBeDefined();
    expect(getSession("sess")?.exited).toBe(false);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Termination requested for session sess.",
    });
  });

  it("remove drops running session immediately when cancellation is requested", async () => {
    supervisorMock.getRecord.mockReturnValue({
      runId: "sess",
      state: "running",
    });
    addSession(createBackgroundSession("sess"));
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "remove",
      sessionId: "sess",
    });

    expect(supervisorMock.cancel).toHaveBeenCalledWith("sess", "manual-cancel");
    expect(getSession("sess")).toBeUndefined();
    expect(getFinishedSession("sess")).toBeUndefined();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Removed session sess (termination requested).",
    });
  });

  it("falls back to process-tree kill when supervisor record is missing", async () => {
    supervisorMock.getRecord.mockReturnValue(undefined);
    addSession(createBackgroundSession("sess-fallback", 4242));
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "kill",
      sessionId: "sess-fallback",
    });

    expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
    expect(getSession("sess-fallback")).toBeUndefined();
    expect(getFinishedSession("sess-fallback")).toBeDefined();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Killed session sess-fallback.",
    });
  });

  it("fails remove when no supervisor record and no pid is available", async () => {
    supervisorMock.getRecord.mockReturnValue(undefined);
    addSession(createBackgroundSession("sess-no-pid"));
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "remove",
      sessionId: "sess-no-pid",
    });

    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(getSession("sess-no-pid")).toBeDefined();
    expect(result.details).toMatchObject({ status: "failed" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Unable to remove session sess-no-pid: no active supervisor run or process id.",
    });
  });
});
