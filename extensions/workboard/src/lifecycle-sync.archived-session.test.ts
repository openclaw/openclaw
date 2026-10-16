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
    "recovers linked $sessionStatus sessions beyond the catalog page without reading unrelated rows",
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
          ...Array.from({ length: 10_000 }, (_, index) => ({
            key: `agent:main:unrelated-${index}`,
            status: "running",
            updatedAt: active.updatedAt + 2,
          })),
          {
            key: sessionKey,
            status: sessionStatus,
            updatedAt: active.updatedAt + 1,
            archivedAt: 1,
          },
          { key: active.sessionKey, status: sessionStatus, updatedAt: active.updatedAt + 1 },
        ];
        let returnedRows = 0;
        const gateway = {
          isAvailable: async () => true,
          request: vi.fn(async (method: string, params: Record<string, unknown>) => {
            if (method === "sessions.describe") {
              const session = sessions.find((row) => row.key === params.key) ?? null;
              returnedRows += session ? 1 : 0;
              return { session };
            }
            // Model the public list's archive filtering and pagination boundary.
            const selected = sessions
              .filter(
                (session) =>
                  params.archived === "all" ||
                  Boolean("archivedAt" in session && session.archivedAt) ===
                    (params.archived === true),
              )
              .slice(0, Number(params.limit));
            returnedRows += selected.length;
            return { sessions: selected };
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
        try {
          await service.start(context);
          service.onGatewayStart();
          expect(operations).toHaveBeenCalled();
          await operations.mock.results[0]?.value;
          expect(context.logger.warn).not.toHaveBeenCalled();
          expect(returnedRows).toBe(2);
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
