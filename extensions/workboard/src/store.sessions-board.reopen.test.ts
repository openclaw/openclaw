import { DatabaseSync } from "node:sqlite";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardWorkspaceBoardMethod } from "./gateway-workspace-methods.js";
import { WorkboardStore } from "./store.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

describe("Sessions board schema reopening", () => {
  it("preserves prior-schema cards and admits a new Sessions board through the Gateway method", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const board = await store.upsertBoard({ id: "planning", name: "Planning", color: "blue" });
    const card = await store.create({
      boardId: board.id,
      title: "Keep the existing card",
      notes: "Prior-schema content",
      labels: ["migration"],
    });
    await store.close();

    {
      using prior = new DatabaseSync(dbPath);
      // These are the only schema additions for Sessions boards; preserve the existing migration receipt.
      prior.exec(`
        DROP TABLE workboard_session_placements;
        ALTER TABLE workboard_boards DROP COLUMN kind;
        ALTER TABLE workboard_boards DROP COLUMN sessions_spec;
      `);
    }

    const reopenedStores = createKernelStores(dbPath);
    const reopened = new WorkboardStore(reopenedStores.cards, reopenedStores);
    try {
      expect((await reopenedStores.boards.lookup(board.id))?.board).toEqual(board);
      const restoredBoard = (await reopened.listBoards()).boards.find(
        (entry) => entry.id === board.id,
      );
      expect(restoredBoard).toMatchObject({
        id: board.id,
        name: "Planning",
        color: "blue",
        total: 1,
      });
      expect(restoredBoard).not.toHaveProperty("kind");
      expect(restoredBoard).not.toHaveProperty("sessions");
      expect(await reopened.get(card.id)).toEqual(card);

      const registerGatewayMethod = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();
      const api = createTestPluginApi({ registerGatewayMethod });
      registerWorkboardWorkspaceBoardMethod({ api, store: reopened });
      const upsert = registerGatewayMethod.mock.calls.find(
        ([method]) => method === "workboard.boards.upsert",
      )![1];
      const respond = vi.fn();
      await upsert({
        params: { id: "sessions", kind: "sessions", name: "Sessions" },
        respond,
      } as never);
      expect(respond).toHaveBeenCalledWith(true, {
        board: expect.objectContaining({ id: "sessions", kind: "sessions", name: "Sessions" }),
      });
      expect(await reopened.getSessionsBoard("sessions")).toMatchObject({
        id: "sessions",
        kind: "sessions",
        sessions: { columns: expect.any(Array) },
      });
      expect(await reopened.listSessionPlacements("sessions")).toEqual([]);
    } finally {
      await reopened.close();
    }

    using migrated = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      migrated.prepare("SELECT COUNT(*) AS count FROM workboard_session_placements").get(),
    ).toEqual({
      count: 0,
    });
  });
});
