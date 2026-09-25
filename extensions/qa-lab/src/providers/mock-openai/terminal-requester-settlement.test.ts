import { describe, expect, it, vi } from "vitest";
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

describe("terminal requester settlement", () => {
  it.each([
    {
      name: "retained owner after lifecycle end",
      session: { ...settledSession, hasActiveRun: true },
    },
    { name: "unknown liveness", session: { ...settledSession, hasActiveRun: undefined } },
    { name: "replacement session", session: { ...settledSession, sessionId: "replacement" } },
    { name: "another agent", session: { ...settledSession, agentId: "other" } },
    { name: "another key", session: { ...settledSession, key: "agent:qa:other" } },
    { name: "aborted owner", session: { ...settledSession, abortedLastRun: true } },
    { name: "failed run", session: { ...settledSession, status: "error" } },
    { name: "hidden row", session: undefined },
  ])("holds the child after HTTP completion for $name", async ({ session }) => {
    const gate = createTerminalRequesterSettleGate();
    let released = false;
    const child = gate.waitUntilSettled(requester.caseName, requester.childSessionKey).then(() => {
      released = true;
    });
    void child.catch(() => {});
    let listedSession = session;
    const call = vi.fn(async (_method: string, params: unknown) => {
      // Published 2026.9.4 rejects this newer sessions.list filter.
      if (params && typeof params === "object" && "excludeSubagents" in params) {
        throw new Error('invalid sessions.list params: unexpected property "excludeSubagents"');
      }
      return { sessions: listedSession ? [listedSession] : [] };
    });
    try {
      gate.onResponseSent(requester);
      await gate.settle({ call });
      expect(released).toBe(false);
      listedSession = settledSession;
      await gate.settle({ call });
      await child;
      expect(released).toBe(true);
      expect(call).toHaveBeenCalledWith(
        "sessions.list",
        {
          agentId: requester.agentId,
          search: requester.sessionKey,
          limit: 100,
        },
        { timeoutMs: 10_000 },
      );
    } finally {
      gate.stop();
      await child.catch(() => {});
    }
  });

  it("accepts inactive requester rows from Gateways that omit lifecycle status", async () => {
    const gate = createTerminalRequesterSettleGate();
    gate.onResponseSent(requester);
    await gate.settle({
      call: async () => ({ sessions: [{ ...settledSession, status: undefined }] }),
    });
    await expect(
      gate.waitUntilSettled(requester.caseName, requester.childSessionKey),
    ).resolves.toBeUndefined();
  });

  it("releases only the child correlated with the settled parent", async () => {
    const gate = createTerminalRequesterSettleGate();
    const other = {
      ...requester,
      sessionId: "other-parent",
      childSessionKey: "agent:qa:subagent:other",
    };
    gate.onResponseSent(requester);
    gate.onResponseSent(other);
    const held = gate.waitUntilSettled(other.caseName, other.childSessionKey);
    const closed = held.then(
      () => "released",
      (error: unknown) => error,
    );
    try {
      await gate.settle({ call: async () => ({ sessions: [settledSession] }) });
      await expect(
        gate.waitUntilSettled(requester.caseName, requester.childSessionKey),
      ).resolves.toBeUndefined();
    } finally {
      gate.stop();
    }
    expect(await closed).toMatchObject({ message: expect.stringContaining("fixture stopped") });
  });

  it("keeps the child held until authoritative requester settlement", async () => {
    vi.useFakeTimers();
    const gate = createTerminalRequesterSettleGate();
    gate.onResponseSent(requester);
    const child = gate.waitUntilSettled(requester.caseName, requester.childSessionKey);
    const outcome = child.then(
      () => "released",
      (error: unknown) => error,
    );
    let completed = false;
    void outcome.then(() => {
      completed = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      expect(completed).toBe(false);
      await gate.settle({ call: async () => ({ sessions: [settledSession] }) });
      await expect(outcome).resolves.toBe("released");
    } finally {
      gate.stop();
      vi.useRealTimers();
    }
  });

  it("fails a terminal requester waiter that never settles", async () => {
    vi.useFakeTimers();
    const gate = createTerminalRequesterSettleGate();
    gate.onResponseSent(requester);
    const child = gate.waitUntilSettled(requester.caseName, requester.childSessionKey);
    const timedOut = expect(child).rejects.toThrow("terminal requester did not settle");
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      await timedOut;
    } finally {
      gate.stop();
      vi.useRealTimers();
    }
  });
});
