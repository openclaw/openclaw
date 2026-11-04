import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";

type TerminalRequester = {
  caseName: string;
  childSessionKey: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
};

type SessionReader = {
  call(method: string, params: unknown, options: { timeoutMs: number }): Promise<unknown>;
};

export type QaTerminalRequesterSettlement = {
  settle(gateway: SessionReader): Promise<void>;
};

export function createTerminalRequesterSettleGate() {
  const settledChildren = new Set<string>();
  const requesters = new Map<string, TerminalRequester>();
  const waiters = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const childKey = (caseName: string, childSessionKey: string) => `${caseName}\n${childSessionKey}`;
  const markSettled = (key: string) => {
    settledChildren.add(key);
    requesters.delete(key);
    waiters.get(key)?.resolve();
  };
  return {
    onResponseSent(requester: TerminalRequester) {
      const key = childKey(requester.caseName, requester.childSessionKey);
      // Provider completion precedes parent cleanup. The scenario's existing
      // readiness loop supplies the exact session's authoritative liveness.
      requesters.set(key, requester);
    },
    async settle(this: void, gateway: SessionReader) {
      for (const [key, requester] of requesters) {
        const response = asOptionalRecord(
          await gateway.call(
            "sessions.list",
            {
              agentId: requester.agentId,
              search: requester.sessionKey,
              limit: 100,
            },
            { timeoutMs: 10_000 },
          ),
        );
        const session = Array.isArray(response?.sessions)
          ? response.sessions
              .map(asOptionalRecord)
              .find(
                (row) =>
                  row?.key === requester.sessionKey &&
                  row.agentId === requester.agentId &&
                  row.sessionId === requester.sessionId,
              )
          : undefined;
        if (
          requesters.get(key) === requester &&
          session?.hasActiveRun === false &&
          (session.status === undefined || session.status === "done") &&
          session.abortedLastRun !== true
        ) {
          markSettled(key);
        }
      }
    },
    async waitUntilSettled(this: void, caseName: string, childSessionKey: string) {
      const key = childKey(caseName, childSessionKey);
      if (settledChildren.has(key)) {
        return;
      }
      const existing = waiters.get(key);
      if (existing) {
        return await existing.promise;
      }
      const completed = createDeferred();
      const promise = raceWithTimeout(completed.promise, 120_000, () => {
        throw new Error(`terminal requester did not settle: ${caseName} (${childSessionKey})`);
      }).finally(() => waiters.delete(key));
      waiters.set(key, { ...completed, promise });
      await promise;
    },
    stop() {
      for (const waiter of waiters.values()) {
        waiter.reject(new Error("terminal requester fixture stopped"));
      }
      waiters.clear();
      requesters.clear();
      settledChildren.clear();
    },
  };
}
