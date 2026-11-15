import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
} from "./lifecycle-sync.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it.each([
  { sessionStatus: "done", cardStatus: "review", provisional: false },
  { sessionStatus: "killed", cardStatus: "blocked", provisional: true },
] as const)(
  "recovers linked $sessionStatus sessions with bounded identity reads",
  async ({ sessionStatus, cardStatus, provisional }) => {
    const store = createWorkboardSqliteTestStore();
    const suffix = "subagent:workboard-archived-worker";
    const sessionKey = `agent:main:${suffix}`;
    const linkedKey = provisional ? suffix : sessionKey;
    const create = (key: string) =>
      store.create({ title: "Recover worker", status: "running", sessionKey: key });
    const card = await create(linkedKey);
    const sibling = await create(linkedKey);
    const activeKey = "agent:main:subagent:workboard-active-worker";
    const active = await create(provisional ? "subagent:workboard-active-worker" : activeKey);
    const sessions = [
      {
        key: sessionKey,
        status: sessionStatus,
        updatedAt: active.updatedAt + 1,
        archivedAt: 1,
      },
      { key: activeKey, status: sessionStatus, updatedAt: active.updatedAt + 1 },
    ];
    let returnedRows = 0;
    const gateway = {
      isAvailable: async () => true,
      request: vi
        .fn<Parameters<typeof readWorkboardLifecycleSessions>[0]["request"]>()
        .mockImplementation(async (method, params = {}) => {
          if (method === "agents.list") {
            return { agents: [{ id: "main" }, { id: "worker" }] };
          }
          if (method === "sessions.describe") {
            const session = sessions.find((row) => row.key === params.key) ?? null;
            returnedRows += session ? 1 : 0;
            return { session };
          }
          throw new Error(`Recovery must read exact identities, not ${method}`);
        }),
    };
    const service = createWorkboardLifecycleService({
      store,
      readSessions: (options) => readWorkboardLifecycleSessions(gateway, options),
    });
    const context = {
      config: {},
      stateDir: "unused",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    using operations = vi.spyOn(store, "runOperation");
    const recover = async () => {
      await service.start(context);
      service.onGatewayStart();
      expect(operations).toHaveBeenCalled();
      await operations.mock.results[0]?.value;
    };
    try {
      await recover();
      expect(context.logger.warn).not.toHaveBeenCalled();
      expect(returnedRows).toBe(2);
      expect(
        gateway.request.mock.calls.filter(([method]) => method === "agents.list"),
      ).toHaveLength(provisional ? 1 : 0);
      for (const { id } of [card, sibling, active]) {
        expect(await store.get(id)).toMatchObject({ status: cardStatus });
      }
      const callsAfterRecovery = gateway.request.mock.calls.length;
      service.onGatewayStop();
      service.stop();
      operations.mockClear();
      await recover();
      expect(gateway.request).toHaveBeenCalledTimes(callsAfterRecovery);
    } finally {
      service.onGatewayStop();
      service.stop();
    }
  },
);
