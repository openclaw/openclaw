import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

let addSession: typeof import("./bash-process-registry.js").addSession;
let getFinishedSession: typeof import("./bash-process-registry.js").getFinishedSession;
let getSession: typeof import("./bash-process-registry.js").getSession;
let markExited: typeof import("./bash-process-registry.js").markExited;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;
let createProcessSessionFixture: typeof import("./bash-process-registry.test-helpers.js").createProcessSessionFixture;
let createProcessTool: typeof import("./bash-tools.process.js").createProcessTool;

function createBackgroundSession(id: string, pid?: number) {
  return createProcessSessionFixture({
    id,
    command: "sleep 999",
    backgrounded: true,
    ...(pid === undefined ? {} : { pid }),
  });
}

describe("process tool supervisor cancellation", () => {
  beforeAll(async () => {
    ({ addSession, getFinishedSession, getSession, markExited, resetProcessRegistryForTests } =
      await import("./bash-process-registry.js"));
    ({ createProcessSessionFixture } = await import("./bash-process-registry.test-helpers.js"));
    ({ createProcessTool } = await import("./bash-tools.process.js"));
  });

  beforeEach(() => {
    supervisorMock.spawn.mockClear();
    supervisorMock.cancel.mockClear();
    supervisorMock.cancelScope.mockClear();
    supervisorMock.reconcileOrphans.mockClear();
    supervisorMock.getRecord.mockClear();
    killProcessTreeMock.mockClear();
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
    expect(getFinishedSession("sess-fallback")).toMatchObject({ status: "killed" });
    expect(result.details).toMatchObject({ status: "completed" });
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

  it("poll reports killed finished sessions without failed tool status", async () => {
    supervisorMock.getRecord.mockReturnValue(undefined);
    const session = createBackgroundSession("sess-killed", 4242);
    addSession(session);
    markExited(session, null, "SIGKILL", "killed");
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "poll",
      sessionId: "sess-killed",
    });

    expect(getFinishedSession("sess-killed")).toMatchObject({ status: "killed" });
    expect(result.details).toMatchObject({ status: "completed" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Process exited with signal SIGKILL."),
    });
  });

  it("log reports killed finished sessions without failed tool status", async () => {
    supervisorMock.getRecord.mockReturnValue(undefined);
    const session = createBackgroundSession("sess-killed", 4242);
    addSession(session);
    markExited(session, null, "SIGKILL", "killed");
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "log",
      sessionId: "sess-killed",
    });

    expect(result.details).toMatchObject({ status: "completed" });
  });
});
