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
  it("waits for gateway startup before beginning the lifecycle sweep", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:main:dashboard:startup-ready";
    const card = await createLinkedCard(store, { status: "todo", sessionKey });
    let gatewayReady = false;
    const readSessions = vi.fn(async () => {
      if (!gatewayReady) {
        throw new Error("sessions.list unavailable during gateway startup");
      }
      return {
        sessions: [{ key: sessionKey, status: "done" as const, updatedAt: card.updatedAt + 1 }],
        complete: true,
      };
    });
    const warn = vi.fn();
    const service = createWorkboardLifecycleService({ store, readSessions });
    const context = { logger: { warn } } as never;
    const runOperation = vi.spyOn(store, "runOperation");
    vi.useFakeTimers();
    try {
      await service.start(context);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(readSessions).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();

      gatewayReady = true;
      service.onGatewayStart();
      await runOperation.mock.results[0]?.value;
      expect((await store.get(card.id))?.status).toBe("review");
      expect(readSessions).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      service.onGatewayStop();
      await runOperation.mock.results[0]?.value;
      runOperation.mockRestore();
      vi.useRealTimers();
    }
  });

  it("begins immediately when the lifecycle service reloads after gateway startup", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:main:dashboard:plugin-reload";
    const card = await createLinkedCard(store, { status: "todo", sessionKey });
    const readSessions = createSessionReader(sessionKey, card.updatedAt);
    const warn = vi.fn();
    const context = { logger: { warn } } as never;
    const original = createWorkboardLifecycleService({ store, readSessions });
    const replacement = createWorkboardLifecycleService({ store, readSessions });
    const lifetime = new AbortController();
    const runOperation = vi.spyOn(store, "runOperation");
    vi.useFakeTimers();
    try {
      await original.start(context);
      original.onGatewayStart(lifetime.signal);
      await runOperation.mock.results[0]?.value;
      expect((await store.get(card.id))?.status).toBe("running");
      original.stop();

      runOperation.mockClear();
      await replacement.start(context);
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
      runOperation.mockRestore();
      vi.useRealTimers();
    }
  });

  it("runs the bounded session reconciliation from the lifecycle-owned service interval", async () => {
    const store = createWorkboardSqliteTestStore();
    const runOperation = vi.spyOn(store, "runOperation");
    vi.useFakeTimers();
    let service: ReturnType<typeof createWorkboardLifecycleService> | undefined;
    try {
      const sessionKey = "agent:main:dashboard:service";
      const card = await createLinkedCard(store, { status: "todo", sessionKey });
      const readSessions = createSessionReader(sessionKey, card.updatedAt);
      service = createWorkboardLifecycleService({ store, readSessions });
      runOperation.mockClear();
      await service.start({ logger: { warn: vi.fn() } } as never);
      service.onGatewayStart();
      expect(runOperation).toHaveBeenCalled();
      // The next interval is armed only after the whole admitted sweep settles.
      await runOperation.mock.results[0]?.value;
      expect((await store.get(card.id))?.status).toBe("running");

      runOperation.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runOperation).toHaveBeenCalled();
      await runOperation.mock.results[0]?.value;
      expect((await store.get(card.id))?.status).toBe("review");

      expect(readSessions).toHaveBeenCalledTimes(2);
    } finally {
      service?.onGatewayStop();
      await service?.stop?.({ logger: { warn: vi.fn() } } as never);
      runOperation.mockRestore();
      vi.useRealTimers();
    }
  });

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
