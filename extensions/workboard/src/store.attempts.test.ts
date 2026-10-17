import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard shared-session attempts", () => {
  it.each([undefined, "shared-run"])(
    "persists terminal attempts for two cards sharing a session and run %s",
    async (runId) => {
      const store = createWorkboardSqliteTestStore();
      const sessionKey = "agent:main:shared-worker";
      const cards = [];
      for (let index = 0; index < 2; index += 1) {
        cards.push(
          await store.create({ title: "Shared worker", status: "running", sessionKey, runId }),
        );
      }
      const now = Math.max(...cards.map((card) => card.updatedAt)) + 1;
      for (const card of cards) {
        await store.syncLifecycle(card.id, {
          targetStatus: "review",
          executionStatus: "done",
          sourceUpdatedAt: now,
          stale: undefined,
          now,
          association: {
            expectedSessionKey: sessionKey,
            expectedRunId: runId,
            sessionKey,
            runId,
          },
        });
      }
      const attempts = [];
      for (const card of cards) {
        const persisted = await store.get(card.id);
        expect(persisted).toMatchObject({
          status: "review",
          metadata: {
            attempts: [
              expect.objectContaining({
                id: expect.any(String),
                status: "succeeded",
                sessionKey,
                ...(runId ? { runId } : {}),
              }),
            ],
          },
        });
        expect(persisted?.metadata?.attempts).toHaveLength(1);
        attempts.push(persisted?.metadata?.attempts?.[0]?.id);
      }
      expect(new Set(attempts).size).toBe(2);
    },
  );
});
