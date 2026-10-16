import { describe, expect, it, vi } from "vitest";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
} from "./lifecycle-sync.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard archived session recovery", () => {
  it.each([
    { sessionStatus: "done", cardStatus: "review" },
    { sessionStatus: "killed", cardStatus: "blocked" },
  ] as const)(
    "recovers both cards linked to a $sessionStatus session after it was archived",
    async ({ sessionStatus, cardStatus }) => {
      vi.useFakeTimers();
      try {
        const store = createWorkboardSqliteTestStore();
        const sessionKey = "agent:main:archived-worker";
        const card = await store.create({
          title: "Recover archived worker",
          status: "running",
          sessionKey,
        });
        const sibling = await store.create({
          title: "Recover the same archived worker",
          status: "running",
          sessionKey,
        });
        const active = await store.create({
          title: "Recover active worker",
          status: "running",
          sessionKey: "agent:main:active-worker",
        });
        const sessions = [
          {
            key: sessionKey,
            status: sessionStatus,
            updatedAt: active.updatedAt + 1,
            archivedAt: 1,
          },
          { key: active.sessionKey, status: sessionStatus, updatedAt: active.updatedAt + 1 },
        ];
        const gateway = {
          isAvailable: async () => true,
          // Match sessions.list's public archive filter: omitted means active only.
          request: vi
            .fn()
            .mockImplementation(async (_method: string, params: Record<string, unknown>) => ({
              sessions: sessions.filter(
                (session) =>
                  params.archived === "all" ||
                  Boolean(session.archivedAt) === (params.archived === true),
              ),
            })),
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
        try {
          await service.start(context);
          service.onGatewayStart();
          expect(operations).toHaveBeenCalled();
          await operations.mock.results[0]?.value;
          expect(context.logger.warn).not.toHaveBeenCalled();
          expect(await store.get(card.id)).toMatchObject({ status: cardStatus });
          expect(await store.get(sibling.id)).toMatchObject({ status: cardStatus });
          expect(await store.get(active.id)).toMatchObject({ status: cardStatus });
        } finally {
          service.onGatewayStop();
          service.stop();
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
