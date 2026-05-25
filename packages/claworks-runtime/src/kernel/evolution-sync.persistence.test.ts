import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../planes/data/db.js";
import { EvolutionSyncManager } from "./evolution-sync.js";

function makeRuntimeWithDb(db: ReturnType<typeof openDatabase>["db"]) {
  return {
    robot: { name: "test-robot-001" },
    robotIdentityManager: { getIdentity: () => ({ id: "test-robot-001" }) },
    db,
    cbrStore: { list: () => [] },
    playbookEngine: {
      list: () => [],
      load: vi.fn(),
      trigger: vi.fn(async () => ({ steps: [], status: "completed" })),
    },
    ruleEngine: { listRules: () => [] },
    promptRegistry: { list: () => [] },
    kb: { ingest: vi.fn(async () => undefined) },
    kernel: { publish: vi.fn(async () => undefined) },
  };
}

describe("EvolutionSyncManager pending promotion persistence", () => {
  it("survives manager re-init after sandbox import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-evolution-pending-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);

    const pack = {
      version: "3.0",
      generated_at: "2026-05-25T12:00:00.000Z",
      generated_by: "test",
      source_robot_id: "robot-a",
      improved_playbooks: [{ id: "pb_persist", steps: [] }],
      summary: "持久化测试",
    };

    const manager1 = new EvolutionSyncManager(makeRuntimeWithDb(db) as never);
    await manager1.importEvolutionPack(pack, { sandbox: true });
    expect(manager1.listPendingSandboxPromotions()).toHaveLength(1);
    const promotionId = manager1.listPendingSandboxPromotions()[0]!.promotion_id;

    const manager2 = new EvolutionSyncManager(makeRuntimeWithDb(db) as never);
    expect(manager2.listPendingSandboxPromotions()).toHaveLength(1);
    expect(manager2.listPendingSandboxPromotions()[0]!.promotion_id).toBe(promotionId);
    expect(manager2.listPendingSandboxPromotions()[0]!.pack.version).toBe("3.0");

    close();
  });
});
