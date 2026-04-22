import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

    it("creates the namespace directory if missing", async () => {
      const ns = "fresh-ns";
      await store.write(ns, { ...SAMPLE_PLAN, namespace: ns });
      const result = await store.read(ns);
      expect(result).not.toBeNull();
    });

    it("rejects namespace with path traversal", async () => {
      await expect(store.read("../../etc")).rejects.toThrow("Invalid plan namespace");
      await expect(store.write("../escape", SAMPLE_PLAN)).rejects.toThrow("Invalid plan namespace");
    });

    it("rejects nested-path namespace (cross-namespace lock collision defense)", async () => {
      await expect(store.read("foo/bar")).rejects.toThrow("Invalid plan namespace");
      await expect(store.write("foo/.lock", SAMPLE_PLAN)).rejects.toThrow("Invalid plan namespace");
    });

    it("rejects namespace with backslash separator", async () => {
      await expect(store.read("foo\\bar")).rejects.toThrow("Invalid plan namespace");
    });

    it("rejects namespace with null byte / control chars", async () => {
      await expect(store.read("foo\x00bar")).rejects.toThrow("Invalid plan namespace");
      await expect(store.read("foo\x01bar")).rejects.toThrow("Invalid plan namespace");
    });

    it("rejects Windows reserved device names", async () => {
      for (const name of ["CON", "PRN", "AUX", "NUL", "COM1", "LPT9", "con.txt", "nul.json"]) {
        await expect(store.read(name)).rejects.toThrow("Invalid plan namespace");
      }
    });

    it("rejects namespace longer than 128 chars", async () => {
      const tooLong = "a".repeat(129);
      await expect(store.read(tooLong)).rejects.toThrow("Invalid plan namespace");
    });

    it("accepts standard namespace patterns", async () => {
      for (const ns of ["session-abc", "user_123", "v2.plan", "Mixed-Case_99"]) {
        await store.write(ns, { ...SAMPLE_PLAN, namespace: ns });
        expect(await store.read(ns)).not.toBeNull();
      }
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
      const incoming: StoredPlanStep[] = [{ step: "Run tests", status: "completed" }];
      const merged = store.mergeSteps(existing, incoming, "session-abc");
      expect(merged).toHaveLength(2);
      expect(merged[0].status).toBe("completed");
      expect(merged[0].updatedBy).toBe("session-abc");
      expect(merged[1].status).toBe("pending"); // Unchanged.
    });

    it("appends new steps not in existing", () => {
      const existing: StoredPlanStep[] = [{ step: "Run tests", status: "completed" }];
      const incoming: StoredPlanStep[] = [{ step: "Deploy", status: "pending" }];
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
      const incoming: StoredPlanStep[] = [{ step: "B", status: "completed" }];
      const merged = store.mergeSteps(existing, incoming);
      expect(merged.map((s) => s.step)).toEqual(["A", "B", "C"]);
    });
  });

  describe("read() — full schema validation pre-parse (Codex P2 r3094816890)", () => {
    async function writeRawPlanFile(namespace: string, contents: unknown): Promise<void> {
      const dir = path.join(tmpDir, namespace);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "plan.json"), JSON.stringify(contents), { mode: 0o600 });
    }

    it("rejects steps: [null] (was: silent pass, then TypeError downstream)", async () => {
      await writeRawPlanFile("ns-bad-step", {
        namespace: "ns-bad-step",
        steps: [null],
        createdAt: 1,
        updatedAt: 2,
      });
      await expect(store.read("ns-bad-step")).rejects.toThrow(/invalid step at index 0/);
    });

    it("rejects step with non-string `step` text", async () => {
      await writeRawPlanFile("ns-bad-step-type", {
        namespace: "ns-bad-step-type",
        steps: [{ step: 42, status: "pending" }],
        createdAt: 1,
        updatedAt: 2,
      });
      await expect(store.read("ns-bad-step-type")).rejects.toThrow(/non-empty string/);
    });

    it("rejects step with empty `step` text", async () => {
      await writeRawPlanFile("ns-empty-step", {
        namespace: "ns-empty-step",
        steps: [{ step: "", status: "pending" }],
        createdAt: 1,
        updatedAt: 2,
      });
      await expect(store.read("ns-empty-step")).rejects.toThrow(/non-empty string/);
    });

    it("rejects step with invalid `status` value", async () => {
      await writeRawPlanFile("ns-bad-status", {
        namespace: "ns-bad-status",
        steps: [{ step: "x", status: "weirdo" }],
        createdAt: 1,
        updatedAt: 2,
      });
      await expect(store.read("ns-bad-status")).rejects.toThrow(/status.*must be one of/);
    });

    it("rejects step with non-string `activeForm` when present", async () => {
      await writeRawPlanFile("ns-bad-active", {
        namespace: "ns-bad-active",
        steps: [{ step: "x", status: "pending", activeForm: 42 }],
        createdAt: 1,
        updatedAt: 2,
      });
      await expect(store.read("ns-bad-active")).rejects.toThrow(/activeForm.*must be a string/);
    });

    it("rejects file missing `createdAt`", async () => {
      await writeRawPlanFile("ns-no-created", {
        namespace: "ns-no-created",
        steps: [{ step: "x", status: "pending" }],
        updatedAt: 2,
      });
      await expect(store.read("ns-no-created")).rejects.toThrow(/createdAt/);
    });

    it("rejects file missing `updatedAt`", async () => {
      await writeRawPlanFile("ns-no-updated", {
        namespace: "ns-no-updated",
        steps: [{ step: "x", status: "pending" }],
        createdAt: 1,
      });
      await expect(store.read("ns-no-updated")).rejects.toThrow(/updatedAt/);
    });

    it("accepts a valid plan with all 4 status values", async () => {
      await writeRawPlanFile("ns-valid", {
        namespace: "ns-valid",
        steps: [
          { step: "a", status: "pending" },
          { step: "b", status: "in_progress", activeForm: "B-ing" },
          { step: "c", status: "completed" },
          { step: "d", status: "cancelled" },
        ],
        createdAt: 1,
        updatedAt: 2,
      });
      const result = await store.read("ns-valid");
      expect(result?.steps).toHaveLength(4);
    });
  });

  describe("stale-lock reclamation (PR-F review #3096520142)", () => {
    it("reclaims a lock whose holder PID is dead and whose mtime is older than LOCK_STALE_MS", async () => {
      // Dead holder PID: PID 0 doesn't correspond to a process on POSIX,
      // and `process.kill(0, 0)` throws ESRCH (treated as dead by the
      // reclamation logic). Avoids picking a real PID by accident.
      const namespace = "ns-stale-lock";
      await fs.mkdir(path.join(tmpDir, namespace), { recursive: true });
      const lockFile = path.join(tmpDir, namespace, ".lock");
      // Plant a stale lock: dead PID + mtime older than 60s.
      await fs.writeFile(lockFile, `0-${Date.now() - 120_000}-deadbeef`);
      const oldMs = (Date.now() - 120_000) / 1000; // 2 min ago in s
      await fs.utimes(lockFile, oldMs, oldMs);
      // lock() should reclaim and acquire successfully (no throw).
      const release = await store.lock(namespace);
      expect(typeof release).toBe("function");
      await release();
    });

    it("does NOT reclaim a fresh lock whose holder PID is alive (the current process)", async () => {
      const namespace = "ns-fresh-lock";
      await fs.mkdir(path.join(tmpDir, namespace), { recursive: true });
      const lockFile = path.join(tmpDir, namespace, ".lock");
      // Plant a fresh lock: current PID (alive) + recent mtime.
      await fs.writeFile(lockFile, `${process.pid}-${Date.now()}-deadbeef`);
      // Acquisition should fail (after retries) because the holder is
      // both fresh AND alive.
      await expect(store.lock(namespace)).rejects.toThrow(/Failed to acquire plan lock/);
      // Manual cleanup so the temp dir teardown is clean.
      await fs.unlink(lockFile);
    });
  });

  describe("confine() — parent-symlink redirection (Codex P1 r3095586226)", () => {
    it("rejects a namespace directory that is a symlink pointing outside baseDir", async () => {
      // Create an attacker-controlled directory outside baseDir.
      const attackerDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-store-attacker-"));
      try {
        // Symlink <baseDir>/hostile -> <attackerDir>
        const symlinkTarget = path.join(tmpDir, "hostile");
        await fs.symlink(attackerDir, symlinkTarget);
        // read() / write() must throw with a 'parent symlink' confinement error.
        // PR-F review fix (Copilot #3096520161 / #3096791944 / Greptile P1
        // #3105248695): pass a complete StoredPlan so the test type-checks
        // under `pnpm tsgo`. The confinement check fires inside `planPath`
        // (called as the first line of `write()`) BEFORE any field is read,
        // so the assertion is unchanged regardless of plan field content.
        await expect(
          store.write("hostile", {
            namespace: "hostile",
            steps: [{ step: "x", status: "pending" }],
            createdAt: 1,
            updatedAt: 1,
          }),
        ).rejects.toThrow(/escapes base directory/);
        // Also verify nothing was written into the attacker directory.
        const filesInAttacker = await fs.readdir(attackerDir);
        expect(filesInAttacker).toHaveLength(0);
      } finally {
        await fs.rm(attackerDir, { recursive: true, force: true });
      }
    });
  });
});
