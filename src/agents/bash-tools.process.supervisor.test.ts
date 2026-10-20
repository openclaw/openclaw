import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as registry from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { isToolResultError } from "./tool-result-error.js";

const { cancel, killTree } = vi.hoisted(() => ({ cancel: vi.fn(), killTree: vi.fn() }));
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => ({ cancel }) }));
vi.mock("../process/kill-tree.js", () => ({ killProcessTree: killTree }));
beforeEach(vi.clearAllMocks);
afterEach(resetProcessRegistryForTests);

function harness(managed = true) {
  const session = createProcessSessionFixture({ id: "session", backgrounded: true, pid: 4242 });
  if (managed) {
    session.processActivity = { resultSettled: false, lastOutputAtMs: session.startedAt };
  }
  registry.addSession(session);
  return { session, call: caller() };
}

function caller(scopeKey?: string) {
  const tool = createProcessTool({ scopeKey });
  return (action: string) => tool.execute(action, { action, sessionId: "session" });
}

it.each([
  ["manual-cancel", { status: "completed", exitSignal: "SIGTERM", timedOut: false }],
  ["overall-timeout", { status: "failed" }],
] as const)("keeps %s distinct from a stop request", async (reason, details) => {
  const { session, call } = harness();
  expect((await call("kill")).content[0]).toMatchObject({
    text: "Termination requested for session session. Use process poll to confirm exit and cleanup before reporting it stopped.",
  });
  expect(cancel).toHaveBeenCalledWith(session.id, "manual-cancel");
  expect(registry.getSession(session.id)?.exited).toBe(false);
  expect(registry.getActiveBackgroundExecSessionCount()).toBe(1);
  registry.markExited(session, null, "SIGTERM", "failed", reason);
  for (const action of ["kill", "poll", "log"]) {
    const result = await call(action);
    expect(result.details).toMatchObject({ ...details, exitReason: reason });
    expect(isToolResultError(result)).toBe(reason === "overall-timeout");
    if (action === "poll" && reason === "manual-cancel") {
      expect(result.content[0]).toMatchObject({
        text: "(no new output)\n\nProcess stopped by request (signal SIGTERM).",
      });
    }
  }
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(registry.getFinishedSession(session.id)?.terminalStatus).toBe("failed");
});

it("remove hides a running session without releasing its active-process count", async () => {
  const { session, call } = harness();
  expect((await call("remove")).content[0]).toMatchObject({
    text: "Removed session session from the process list. Termination was requested but is not yet confirmed.",
  });
  expect(cancel).toHaveBeenCalledWith(session.id, "manual-cancel");
  expect(registry.getSession(session.id)).toBeUndefined();
  expect(registry.getFinishedSession(session.id)).toBeUndefined();
  expect(registry.getActiveBackgroundExecSessionCount()).toBe(1);
  registry.markExited(session, null, "SIGTERM", "failed", "manual-cancel");
  expect(registry.getActiveBackgroundExecSessionCount()).toBe(0);
  expect(registry.getFinishedSession(session.id)).toBeUndefined();
});

it("removes a retained completed session and its logs", async () => {
  const { session, call } = harness();
  registry.markExited(session, 0, null, "completed");
  expect((await call("kill")).details).toMatchObject({ status: "completed", exitCode: 0 });
  expect(cancel).not.toHaveBeenCalled();
  expect((await call("remove")).details).toMatchObject({ status: "completed" });
  expect((await call("log")).details).toMatchObject({
    status: "failed",
    error: `No session found for ${session.id}`,
  });
  expect((await call("kill")).details).toMatchObject({
    status: "failed",
    error: `No active session found for ${session.id}`,
  });
});

it("keeps terminal observations scoped when a cleared process id is reused", async () => {
  const { session, call } = harness();
  session.scopeKey = "owner";
  registry.markExited(session, 0, null, "completed");
  const otherCall = caller("other");
  expect((await otherCall("kill")).details).toMatchObject({ status: "failed" });
  await call("clear");
  const successor = harness().session;
  successor.scopeKey = "other";
  expect((await caller("owner")("kill")).details).toMatchObject({ status: "failed" });
  expect(cancel).not.toHaveBeenCalled();
  expect((await otherCall("kill")).details).toMatchObject({
    cancellationRequested: true,
    terminationConfirmed: false,
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(registry.getSession(session.id)).toBe(successor);
});

it.each([
  ["kill", false],
  ["remove", false],
  ["kill", true],
  ["remove", true],
] as const)(
  "refuses %s without cancellation authority (finalizing=%s)",
  async (action, finalizing) => {
    const { session, call } = harness(finalizing);
    if (finalizing) {
      session.processActivity = { resultSettled: true, lastOutputAtMs: session.startedAt };
      session.finalizing = true;
    }
    const result = await call(action);
    expect(cancel).not.toHaveBeenCalled();
    expect(killTree).not.toHaveBeenCalled();
    expect(registry.getSession(session.id)?.exited).toBe(false);
    const message = finalizing ? "is finalizing" : "no active supervisor cancellation handle";
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(message) });
    expect(result.details).toMatchObject({ status: "failed" });
  },
);
