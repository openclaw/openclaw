// Cross-repo wire-contract test (recon A-S2). The fixture file
// `wire-contract.json` is mirrored byte-for-byte in MissionControl
// at `__tests__/contract/wire-contract.json`. The pinned SHA-256 in
// `wire-contract.sha256` is the same file in both repos. If the
// schema (or any of these representative records) drifts in either
// repo without updating the fixture in lockstep, the local test fails
// — a sentinel check that catches cross-repo divergence at CI time.
//
// When updating the wire format:
//   1. Edit `wire-contract.json` in BOTH repos identically.
//   2. Recompute the hash:
//      `node -e "const c=require('crypto');const fs=require('fs');console.log(c.createHash('sha256').update(fs.readFileSync('extensions/orchestrator/test/fixtures/wire-contract.json')).digest('hex'))"`
//   3. Paste the new hash into `wire-contract.sha256` in BOTH repos.
//   4. Update the openclaw `Task` type in `extensions/orchestrator/src/types/schema.ts`
//      AND the MC `Task` type in `lib/orchestrator/trajectory.ts` so
//      both compile against the new shape.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Task, TaskTrajectoryEvent } from "../src/types/schema.js";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIXTURE_PATH = resolve(FIXTURE_DIR, "wire-contract.json");
const HASH_PATH = resolve(FIXTURE_DIR, "wire-contract.sha256");

interface WireContractFile {
  schemaVersion: 1;
  description: string;
  tasks: Task[];
  trajectoryEvents: TaskTrajectoryEvent[];
}

describe("wire-contract", () => {
  test("fixture sha256 matches the pinned hash", () => {
    const fixtureBytes = readFileSync(FIXTURE_PATH);
    const actual = createHash("sha256").update(fixtureBytes).digest("hex");
    const pinned = readFileSync(HASH_PATH, "utf8").trim();
    expect(actual).toBe(pinned);
  });

  test("fixture parses as JSON with schemaVersion 1", () => {
    const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as
      | WireContractFile
      | { schemaVersion?: unknown };
    expect((parsed as WireContractFile).schemaVersion).toBe(1);
    expect(Array.isArray((parsed as WireContractFile).tasks)).toBe(true);
    expect(Array.isArray((parsed as WireContractFile).trajectoryEvents)).toBe(true);
  });

  test("every fixture task has the canonical shape", () => {
    const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as WireContractFile;
    for (const task of parsed.tasks) {
      expect(task.schemaVersion).toBe(1);
      expect(typeof task.id).toBe("string");
      expect(["live", "synthetic", "shadow"]).toContain(task.kind);
      expect([
        "queued",
        "assigned",
        "in_progress",
        "awaiting_approval",
        "done",
        "failed",
        "cancelled",
        "expired",
      ]).toContain(task.state);
      expect(typeof task.createdAt).toBe("string");
      expect(typeof task.expiresAt).toBe("string");
      // Invariants from schema.ts. Routing is required for the
      // routed-then-progressed states; expired / cancelled / failed
      // tasks may have died before routing ran (e.g. queued → expired
      // via sweeper) and therefore retain `routing: null`.
      if (task.state === "queued") {
        expect(task.routing).toBeNull();
        expect(task.assignedAgentId).toBeNull();
      }
      const routedStates = new Set(["assigned", "in_progress", "awaiting_approval", "done"]);
      if (routedStates.has(task.state)) {
        expect(task.routing).not.toBeNull();
        expect(task.assignedAgentId).not.toBeNull();
      }
    }
  });

  test("fixture covers every task state at least once", () => {
    const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as WireContractFile;
    const states = new Set(parsed.tasks.map((t) => t.state));
    for (const state of [
      "queued",
      "assigned",
      "awaiting_approval",
      "done",
      "failed",
      "expired",
    ] as const) {
      expect(states.has(state)).toBe(true);
    }
  });

  test("fixture covers every task kind at least once", () => {
    const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as WireContractFile;
    const kinds = new Set(parsed.tasks.map((t) => t.kind));
    expect(kinds.has("live")).toBe(true);
    expect(kinds.has("synthetic")).toBe(true);
    expect(kinds.has("shadow")).toBe(true);
  });

  test("trajectory events use the canonical envelope", () => {
    const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as WireContractFile;
    for (const event of parsed.trajectoryEvents) {
      expect(event.traceSchema).toBe("openclaw-trajectory");
      expect(event.schemaVersion).toBe(1);
      expect(event.source).toBe("runtime");
      expect(event.type.startsWith("task.")).toBe(true);
    }
  });
});
