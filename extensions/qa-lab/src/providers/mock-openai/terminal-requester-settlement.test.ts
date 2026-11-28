import { afterEach, expect, it, vi } from "vitest";
import { createTerminalRequesterSettleGate } from "./terminal-requester-settlement.js";

const requester = {
  caseName: "fallback",
  childSessionKey: "agent:qa:subagent:child",
  agentId: "qa",
  sessionKey: "agent:qa:main",
  sessionId: "parent-session",
};
const settledSession = {
  key: requester.sessionKey,
  agentId: requester.agentId,
  sessionId: requester.sessionId,
  status: "done",
  hasActiveRun: false,
  abortedLastRun: false,
};

let gate = createTerminalRequesterSettleGate();
const wait = (target = requester) => gate.waitUntilSettled(target.caseName, target.childSessionKey);
const outcome = (target = requester) => wait(target).catch((error: unknown) => error);
afterEach(() => {
  gate.stop();
  gate = createTerminalRequesterSettleGate();
  vi.useRealTimers();
});

it.each([
  { name: "retained owner after lifecycle end", hasActiveRun: true },
  { name: "unknown liveness", hasActiveRun: undefined },
  { name: "another agent", agentId: "other" },
  { name: "another key", key: "agent:qa:other" },
  { name: "aborted owner", abortedLastRun: true },
  { name: "failed run", status: "error" },
])("requires settlement: $name", async ({ name: _name, ...overrides }) => {
  const released = vi.fn();
  const child = wait().then(released);
  void child.catch(() => {});
  let listedSession = { ...settledSession, ...overrides };
  const call = vi.fn(async (method: string, params: unknown, options: unknown) => {
    // Published 2026.9.4 rejects newer filters such as excludeSubagents.
    expect([method, params, options]).toEqual([
      "sessions.list",
      { agentId: requester.agentId, search: requester.sessionKey, limit: 100 },
      { timeoutMs: 10_000 },
    ]);
    return { sessions: [listedSession] };
  });
  gate.onResponseSent(requester);
  await gate.settle({ call });
  expect(released).not.toHaveBeenCalled();
  listedSession = settledSession;
  await gate.settle({ call });
  await child;
});

it("releases only the child correlated with the settled parent", async () => {
  const other = {
    ...requester,
    sessionId: "other-parent",
    childSessionKey: "agent:qa:subagent:other",
  };
  gate.onResponseSent(requester);
  gate.onResponseSent(other);
  const closed = outcome(other);
  const shared = outcome(other);
  await gate.settle({ call: async () => ({ sessions: [settledSession] }) });
  await expect(wait()).resolves.toBeUndefined();
  gate.stop();
  expect(await closed).toMatchObject({ message: expect.stringContaining("fixture stopped") });
  expect(await shared).toBe(await closed);
});

it.each([false, true])("waits for settlement or timeout (settle=%s)", async (settle) => {
  vi.useFakeTimers();
  gate.onResponseSent(requester);
  const result = outcome();
  const completed = vi.fn();
  void result.then(completed);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(completed).not.toHaveBeenCalled();
  if (settle) {
    // Older Gateways omit lifecycle status; inactive ownership still settles.
    await gate.settle({
      call: async () => ({ sessions: [{ ...settledSession, status: undefined }] }),
    });
    await expect(result).resolves.toBeUndefined();
  } else {
    await vi.advanceTimersByTimeAsync(89_000);
    expect(await result).toBeInstanceOf(Error);
    expect(await result).toMatchObject({
      message: expect.stringContaining("terminal requester did not settle"),
    });
  }
});
