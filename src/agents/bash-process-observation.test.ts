import { afterEach, expect, it, vi } from "vitest";
import {
  countRunningBackgroundProcesses,
  prepareRunningBackgroundProcessCount,
  readBackgroundProcesses,
  stopBackgroundProcess,
} from "./bash-process-observation.js";
import {
  addSession,
  appendOutput,
  deleteSession,
  markBackgrounded,
  markExited,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";

const { cancel } = vi.hoisted(() => ({ cancel: vi.fn(() => true) }));
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => ({ cancel }) }));
afterEach(() => {
  resetProcessRegistryForTests();
  cancel.mockClear();
});
const scope = { scopeKeys: ["agent:main:owner"], agentId: "main" };
const seed = (id: string, scopeKey = scope.scopeKeys[0]) => {
  const session = createProcessSessionFixture({ id, backgrounded: true, startedAt: 1 });
  session.scopeKey = scopeKey;
  session.agentId = "main";
  session.processActivity = { resultSettled: false, lastOutputAtMs: session.startedAt };
  addSession(session);
  return session;
};

it("indexes unique scope matches with live foreground, exit, removal and global ownership", () => {
  const canonical = seed("canonical");
  seed("legacy", "legacy").agentId = undefined;
  seed("session-id", "session-id");
  seed("other-agent").agentId = "other";
  seed("global", "global");
  seed("unowned-global", "global").agentId = undefined;
  seed("exited").exited = true;
  const foreground = seed("foreground");
  foreground.backgrounded = false;
  const query = {
    scopeKeys: [scope.scopeKeys[0]!, "legacy", "session-id", "legacy"],
    agentId: "main",
  };
  const read = prepareRunningBackgroundProcessCount();
  expect(read(query)).toBe(3);
  expect(read({ ...query, agentId: "other" })).toBe(2);
  expect(read({ scopeKeys: ["global", "global"], agentId: "main" })).toBe(1);
  expect(read({ scopeKeys: ["global"], agentId: "other" })).toBe(0);
  expect(read({ scopeKeys: ["missing"], agentId: "main" })).toBe(0);
  markBackgrounded(foreground);
  expect(prepareRunningBackgroundProcessCount()(query)).toBe(4);
  markExited(canonical, 0, null, "completed");
  deleteSession("legacy");
  expect(prepareRunningBackgroundProcessCount()(query)).toBe(2);
});

it("keeps the observed incarnation through completion and refuses a same-slug successor", () => {
  const first = seed("same-slug");
  const observed = readBackgroundProcesses(scope).processes[0]!;
  expect(stopBackgroundProcess(scope, observed)).toEqual({ requested: true });
  expect(cancel).toHaveBeenCalledExactlyOnceWith(first.id, "manual-cancel");
  markExited(first, 0, null, "completed");
  expect(readBackgroundProcesses(scope).processes[0]?.instanceId).toBe(observed.instanceId);
  deleteSession(first.id);
  const replacement = seed(first.id);
  cancel.mockClear();
  expect(stopBackgroundProcess(scope, observed)).toEqual({ requested: false });
  expect(cancel).not.toHaveBeenCalled();
  expect(readBackgroundProcesses(scope).processes[0]?.instanceId).not.toBe(observed.instanceId);
  expect(
    stopBackgroundProcess(
      { ...scope, scopeKeys: ["another-session"] },
      {
        processId: replacement.id,
        instanceId: readBackgroundProcesses(scope).processes[0]!.instanceId,
      },
    ),
  ).toEqual({ requested: false });
});

it("bounds encoded output and rows without consuming agent output or crossing global agent scope", () => {
  for (let i = 0; i < 80; i++) {
    const session = seed(String(i));
    appendOutput(session, "stdout", "界".repeat(2200));
  }
  const result = readBackgroundProcesses(scope);
  expect(countRunningBackgroundProcesses(scope)).toBe(80);
  expect(result.truncated).toBe(true);
  expect(result.processes.length).toBeGreaterThan(0);
  expect(result.processes.length).toBeLessThanOrEqual(50);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(50 * 1024);
  expect(result.processes.every((row) => row.tail.length <= 2000 && row.truncated)).toBe(true);
  const global = seed("global-main", "global");
  const readGlobal = { scopeKeys: ["global"], agentId: "other" };
  expect(readBackgroundProcesses(readGlobal).processes).toEqual([]);
  expect(countRunningBackgroundProcesses(readGlobal)).toBe(0);
  global.agentId = undefined;
  expect(readBackgroundProcesses({ ...readGlobal, agentId: "main" }).processes).toEqual([]);
  expect(countRunningBackgroundProcesses({ ...readGlobal, agentId: "main" })).toBe(0);
});

it.each([
  { requested: true, reason: "manual-cancel", cleanupFailed: false, status: "killed" },
  { requested: true, reason: "overall-timeout", cleanupFailed: false, status: "failed" },
  { requested: true, reason: "manual-cancel", cleanupFailed: true, status: "failed" },
  { requested: false, reason: "manual-cancel", cleanupFailed: false, status: "failed" },
] as const)(
  "projects confirmed Stop without hiding other failures: $reason/$cleanupFailed/$requested",
  ({ requested, reason, cleanupFailed, status }) => {
    const session = seed("stop-outcome");
    session.cancellationRequested = requested;
    session.finalizationFailed = cleanupFailed;
    markExited(session, null, "SIGTERM", "failed", reason);
    expect(readBackgroundProcesses(scope).processes[0]).toMatchObject({ status, canStop: false });
  },
);
