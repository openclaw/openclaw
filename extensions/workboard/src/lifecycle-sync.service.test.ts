import { describe, expect, it, vi } from "vitest";
import { createWorkboardLifecycleService } from "./lifecycle-sync.js";
import { createDeferred, createLinkedCard } from "./lifecycle-sync.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

function createSessionReader(sessionKey: string, updatedAt: number) {
  return vi
    .fn()
    .mockResolvedValueOnce({
      sessions: [
        { key: sessionKey, status: "running", hasActiveRun: true, updatedAt: updatedAt + 1 },
      ],
      complete: true,
    })
    .mockResolvedValueOnce({
      sessions: [
        { key: sessionKey, status: "done", hasActiveRun: false, updatedAt: updatedAt + 2 },
      ],
      complete: true,
    });
}

describe("Workboard lifecycle service", () => {
  it.each(["interval", "plugin reload"] as const)(
    "waits for Gateway readiness and reconciles again after %s until drain",
    async (trigger) => {
      const store = createWorkboardSqliteTestStore();
      const sessionKey = "agent:main:dashboard:startup-ready";
      const card = await createLinkedCard(store, { status: "todo", sessionKey });
      const readReadySessions = createSessionReader(sessionKey, card.updatedAt);
      let gatewayReady = false;
      const readSessions = vi.fn(async () => {
        if (!gatewayReady) {
          throw new Error("sessions.list unavailable during gateway startup");
        }
        return readReadySessions();
      });
      const warn = vi.fn();
      const original = createWorkboardLifecycleService({ store, readSessions });
      const replacement = createWorkboardLifecycleService({ store, readSessions });
      const context = { logger: { warn } } as never;
      const lifetime = new AbortController();
      const runOperation = vi.spyOn(store, "runOperation");
      vi.useFakeTimers();
      try {
        await original.start(context);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(readSessions).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();

        gatewayReady = true;
        original.onGatewayStart(lifetime.signal);
        expect(runOperation).toHaveBeenCalled();
        await runOperation.mock.results[0]?.value;
        expect((await store.get(card.id))?.status).toBe("running");
        expect(readSessions).toHaveBeenCalledOnce();
        expect(warn).not.toHaveBeenCalled();

        runOperation.mockClear();
        if (trigger === "plugin reload") {
          original.stop();
          await replacement.start(context);
        } else {
          // The interval is armed only after the admitted sweep settles.
          await vi.advanceTimersByTimeAsync(60_000);
        }
        expect(runOperation).toHaveBeenCalled();
        await runOperation.mock.results[0]?.value;
        expect((await store.get(card.id))?.status).toBe("review");
        const admittedSweeps = runOperation.mock.calls.length;
        lifetime.abort();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(runOperation).toHaveBeenCalledTimes(admittedSweeps);
        expect(readSessions).toHaveBeenCalledTimes(2);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        original.stop();
        replacement.onGatewayStop();
        await runOperation.mock.results[0]?.value;
        runOperation.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("fences an in-flight session read as soon as the Gateway drains", async () => {
    const store = createWorkboardSqliteTestStore();
    await createLinkedCard(store, { sessionKey: "agent:main:dashboard:draining" });
    const runOperation = vi.spyOn(store, "runOperation");
    const lifetime = new AbortController();
    const readEntered = createDeferred<void>();
    const readResult = createDeferred<{ sessions: []; complete: boolean }>();
    const readSessions = vi.fn(async () => {
      readEntered.resolve();
      return await readResult.promise;
    });
    const warn = vi.fn();
    const service = createWorkboardLifecycleService({ store, readSessions });
    vi.useFakeTimers();
    try {
      await service.start({ logger: { warn } } as never);
      service.onGatewayStart(lifetime.signal);
      await readEntered.promise;
      lifetime.abort();
      readResult.reject(new Error("Gateway request entry is closed"));
      await runOperation.mock.results[0]?.value;
      const admittedSweeps = runOperation.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3 * 60_000);

      expect(runOperation).toHaveBeenCalledTimes(admittedSweeps);
      expect(readSessions).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      readResult.resolve({ sessions: [], complete: true });
      service.onGatewayStop();
      await runOperation.mock.results[0]?.value;
      runOperation.mockRestore();
      vi.useRealTimers();
    }
  });
});
