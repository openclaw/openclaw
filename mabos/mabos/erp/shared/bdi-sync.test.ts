import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BdiSyncEngine } from "./bdi-sync.js";

describe("BdiSyncEngine", () => {
  let tempDir: string;
  let mockPg: { query: ReturnType<typeof vi.fn> };
  let engine: BdiSyncEngine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bdi-sync-test-"));
    mockPg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    engine = new BdiSyncEngine(mockPg as any, { info: vi.fn(), warn: vi.fn() });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("syncErpToBdi", () => {
    it("appends a desire when a project is created", async () => {
      await engine.syncErpToBdi({
        agentDir: tempDir,
        agentId: "agent-1",
        domain: "projects",
        entityType: "project",
        trigger: "create",
        record: {
          id: "proj-1",
          name: "Q1 Campaign",
          priority: 0.8,
          budget: 50000,
          start_date: "2026-03-01",
          end_date: "2026-06-01",
          status: "active",
        },
      });
      const desires = await readFile(join(tempDir, "Desires.md"), "utf-8");
      expect(desires).toContain("Q1 Campaign");
      expect(desires).toContain("[erp:projects:proj-1]");
      expect(desires).toContain("priority: 0.8");
    });

    it("deduplicates on re-sync of same entity", async () => {
      const record = {
        id: "proj-1",
        name: "Q1 Campaign",
        priority: 0.8,
        budget: 50000,
        start_date: "2026-03-01",
        end_date: "2026-06-01",
        status: "active",
      };
      await engine.syncErpToBdi({
        agentDir: tempDir,
        agentId: "agent-1",
        domain: "projects",
        entityType: "project",
        trigger: "create",
        record,
      });
      await engine.syncErpToBdi({
        agentDir: tempDir,
        agentId: "agent-1",
        domain: "projects",
        entityType: "project",
        trigger: "create",
        record: { ...record, status: "in_progress" },
      });
      const desires = await readFile(join(tempDir, "Desires.md"), "utf-8");
      const matches = desires.match(/\[erp:projects:proj-1\]/g);
      expect(matches).toHaveLength(1);
    });

    it("does nothing when no matching rule exists", async () => {
      await engine.syncErpToBdi({
        agentDir: tempDir,
        agentId: "agent-1",
        domain: "unknown",
        entityType: "thing",
        trigger: "create",
        record: { id: "x" },
      });
      expect(engine.getRecentEvents()).toHaveLength(0);
    });

    it("logs sync events", async () => {
      await engine.syncErpToBdi({
        agentDir: tempDir,
        agentId: "agent-1",
        domain: "projects",
        entityType: "project",
        trigger: "create",
        record: { id: "p1", name: "Test", status: "active" },
      });
      const events = engine.getRecentEvents();
      expect(events).toHaveLength(1);
      expect(events[0].direction).toBe("erp-to-bdi");
      expect(events[0].domain).toBe("projects");
    });
  });

  describe("syncBdiToErp", () => {
    it("pushes update when intention status changes to stalled", async () => {
      const prev = {
        intentions: "## Task A [erp:projects:task-1]\n- status: active\n",
        desires: "",
        goals: "",
      };
      const curr = {
        intentions: "## Task A [erp:projects:task-1]\n- status: stalled\n",
        desires: "",
        goals: "",
      };
      const updates = await engine.syncBdiToErp({
        agentDir: tempDir,
        agentId: "agent-1",
        previousState: prev,
        currentState: curr,
      });
      expect(updates).toBe(1);
      expect(mockPg.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE erp.projects"),
        expect.arrayContaining(["task-1", "blocked"]),
      );
    });

    it("pushes update when desire is dropped", async () => {
      const prev = {
        intentions: "",
        desires: "## My Project [erp:projects:proj-1]\n- status: active\n",
        goals: "",
      };
      const curr = {
        intentions: "",
        desires: "## My Project [erp:projects:proj-1]\n- status: dropped\n",
        goals: "",
      };
      const updates = await engine.syncBdiToErp({
        agentDir: tempDir,
        agentId: "agent-1",
        previousState: prev,
        currentState: curr,
      });
      expect(updates).toBe(1);
      expect(mockPg.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE erp.projects"),
        expect.arrayContaining(["proj-1", "on_hold"]),
      );
    });

    it("returns 0 when no status changes", async () => {
      const state = {
        intentions: "## Task A [erp:projects:task-1]\n- status: active\n",
        desires: "",
        goals: "",
      };
      const updates = await engine.syncBdiToErp({
        agentDir: tempDir,
        agentId: "agent-1",
        previousState: state,
        currentState: state,
      });
      expect(updates).toBe(0);
      expect(mockPg.query).not.toHaveBeenCalled();
    });

    it("handles compliance violation resolution", async () => {
      const prev = {
        intentions: "",
        desires: "",
        goals: "## Resolve: product violation [erp:compliance:v-1]\n- status: open\n",
      };
      const curr = {
        intentions: "",
        desires: "",
        goals: "## Resolve: product violation [erp:compliance:v-1]\n- status: resolved\n",
      };
      const updates = await engine.syncBdiToErp({
        agentDir: tempDir,
        agentId: "agent-1",
        previousState: prev,
        currentState: curr,
      });
      expect(updates).toBe(1);
    });
  });
});
