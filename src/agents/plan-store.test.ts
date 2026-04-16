import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlanStore, type StoredPlan, type StoredPlanStep } from "./plan-store.js";

let tmpDir: string;
let store: PlanStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-store-test-"));
  store = new PlanStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const SAMPLE_PLAN: StoredPlan = {
  namespace: "test-ns",
  steps: [
    { step: "Run tests", status: "completed" },
    { step: "Build", status: "in_progress", activeForm: "Building" },
    { step: "Deploy", status: "pending" },
  ],
  createdAt: 1000,
  updatedAt: 2000,
};

describe("PlanStore", () => {
  describe("read/write", () => {
    it("returns null for non-existent namespace", async () => {
      expect(await store.read("nonexistent")).toBeNull();
    });

    it("round-trips a plan", async () => {
      await store.write("test-ns", SAMPLE_PLAN);
      const result = await store.read("test-ns");
      expect(result).toEqual(SAMPLE_PLAN);
    });

    it("creates nested directory if missing", async () => {
      await store.write("deep/nested/ns", { ...SAMPLE_PLAN, namespace: "deep/nested/ns" });
      const result = await store.read("deep/nested/ns");
      expect(result).not.toBeNull();
    });

    it("rejects namespace with path traversal", async () => {
      await expect(store.read("../../etc")).rejects.toThrow("Invalid plan namespace");
      await expect(store.write("../escape", SAMPLE_PLAN)).rejects.toThrow("Invalid plan namespace");
    });

    it("rejects namespace mismatch in write", async () => {
      await expect(store.write("wrong-ns", SAMPLE_PLAN)).rejects.toThrow("namespace mismatch");
    });
  });

  describe("lock", () => {
    it("acquires and releases a lock", async () => {
      const release = await store.lock("test-ns");
      // Lock file should exist.
      const lockPath = path.join(tmpDir, "test-ns", ".lock");
      await expect(fs.stat(lockPath)).resolves.toBeDefined();
      await release();
      // Lock file should be removed.
      await expect(fs.stat(lockPath)).rejects.toThrow();
    });

    it("blocks concurrent lock acquisition", async () => {
      const release1 = await store.lock("test-ns");
      // Second lock should timeout/retry (we don't wait the full retry cycle).
      const lock2Promise = store.lock("test-ns");
      // Release first lock after a short delay.
      setTimeout(() => release1(), 100);
      const release2 = await lock2Promise;
      await release2();
    });
  });

  describe("mergeSteps", () => {
    it("updates existing steps by matching text", () => {
      const existing: StoredPlanStep[] = [
        { step: "Run tests", status: "pending" },
        { step: "Build", status: "pending" },
      ];
      const incoming: StoredPlanStep[] = [
        { step: "Run tests", status: "completed" },
      ];
      const merged = store.mergeSteps(existing, incoming, "session-abc");
      expect(merged).toHaveLength(2);
      expect(merged[0].status).toBe("completed");
      expect(merged[0].updatedBy).toBe("session-abc");
      expect(merged[1].status).toBe("pending"); // Unchanged.
    });

    it("appends new steps not in existing", () => {
      const existing: StoredPlanStep[] = [
        { step: "Run tests", status: "completed" },
      ];
      const incoming: StoredPlanStep[] = [
        { step: "Deploy", status: "pending" },
      ];
      const merged = store.mergeSteps(existing, incoming);
      expect(merged).toHaveLength(2);
      expect(merged[1].step).toBe("Deploy");
    });

    it("preserves order of existing steps", () => {
      const existing: StoredPlanStep[] = [
        { step: "A", status: "pending" },
        { step: "B", status: "pending" },
        { step: "C", status: "pending" },
      ];
      const incoming: StoredPlanStep[] = [
        { step: "B", status: "completed" },
      ];
      const merged = store.mergeSteps(existing, incoming);
      expect(merged.map((s) => s.step)).toEqual(["A", "B", "C"]);
    });
  });
});
