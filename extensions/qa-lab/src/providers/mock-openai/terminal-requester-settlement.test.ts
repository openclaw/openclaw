import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

let gate: ReturnType<typeof createTerminalRequesterSettleGate>;
beforeEach(() => {
  gate = createTerminalRequesterSettleGate();
});
afterEach(() => {
  gate.stop();
  vi.useRealTimers();
});

describe("terminal requester settlement", () => {
  it.each([
    {
      name: "retained owner after lifecycle end",
      session: { ...settledSession, hasActiveRun: true },
    },
    { name: "unknown liveness", session: { ...settledSession, hasActiveRun: undefined } },
    { name: "another agent", session: { ...settledSession, agentId: "other" } },
    { name: "another key", session: { ...settledSession, key: "agent:qa:other" } },
    { name: "aborted owner", session: { ...settledSession, abortedLastRun: true } },
    { name: "failed run", session: { ...settledSession, status: "error" } },
  ])("requires authoritative requester settlement: $name", async ({ session }) => {
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
      return { sessions: [listedSession] };
    });
    gate.onResponseSent(requester);
    await gate.settle({ call });
    expect(released).toBe(false);
    listedSession = settledSession;
    await gate.settle({ call });
    await child;
    expect(released).toBe(true);
    expect(call).toHaveBeenCalledWith(
      "sessions.list",
      { agentId: requester.agentId, search: requester.sessionKey, limit: 100 },
      { timeoutMs: 10_000 },
    );
  });

  it("releases only the child correlated with the settled parent", async () => {
    const other = {
      ...requester,
      sessionId: "other-parent",
      childSessionKey: "agent:qa:subagent:other",
    };
    gate.onResponseSent(requester);
    gate.onResponseSent(other);
    const closed = gate.waitUntilSettled(other.caseName, other.childSessionKey).then(
      () => "released",
      (error: unknown) => error,
    );
    await gate.settle({ call: async () => ({ sessions: [settledSession] }) });
    await expect(
      gate.waitUntilSettled(requester.caseName, requester.childSessionKey),
    ).resolves.toBeUndefined();
    gate.stop();
    expect(await closed).toMatchObject({ message: expect.stringContaining("fixture stopped") });
  });

  it.each([false, true])(
    "keeps the child held until settlement or timeout (settle=%s)",
    async (settle) => {
      vi.useFakeTimers();
      gate.onResponseSent(requester);
      const outcome = gate.waitUntilSettled(requester.caseName, requester.childSessionKey).then(
        () => "released",
        (error: unknown) => error,
      );
      let completed = false;
      void outcome.then(() => {
        completed = true;
      });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(completed).toBe(false);
      if (settle) {
        // Older Gateways omit lifecycle status; inactive ownership still settles.
        await gate.settle({
          call: async () => ({ sessions: [{ ...settledSession, status: undefined }] }),
        });
        await expect(outcome).resolves.toBe("released");
        await expect(
          gate.waitUntilSettled(requester.caseName, requester.childSessionKey),
        ).resolves.toBeUndefined();
      } else {
        await vi.advanceTimersByTimeAsync(89_000);
        expect(await outcome).toBeInstanceOf(Error);
        expect(await outcome).toMatchObject({
          message: expect.stringContaining("terminal requester did not settle"),
        });
      }
    },
  );
});
