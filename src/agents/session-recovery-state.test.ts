import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTaskLedgerEvent,
  buildSessionRecoveryPromptInputFromBundle,
  loadRecoveryBundle,
  readTaskLedgerEvents,
  redactSensitiveText,
  resolveRecoveryBundlePath,
  resolveTaskLedgerPath,
  saveRecoveryBundle,
} from "./session-recovery-state.js";

const LOCKFILE_PATCH_HASH = "23ec8efe1484afa57c51b96955ba331d1467521a8e676a18c2690da7e70a6201";

describe("session recovery state", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-recovery-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
  });

  afterEach(async () => {
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
  });

  it("appends ledger events without overwriting previous entries", () => {
    const first = appendTaskLedgerEvent({
      taskId: "task-memory-mvp",
      actorType: "agent",
      actorId: "avery",
      eventType: "task_started",
      summary: "Started recovery bundle MVP",
      sourceRefs: ["session:abc"],
      now: new Date("2026-04-26T21:23:00.000Z"),
    });
    const second = appendTaskLedgerEvent({
      taskId: "task-memory-mvp",
      actorType: "agent",
      actorId: "forge",
      eventType: "validation_done",
      summary: "Targeted tests passed",
      confidence: "confirmed",
      now: new Date("2026-04-26T21:24:00.000Z"),
    });

    const result = readTaskLedgerEvents();

    expect(result.invalidLines).toBe(0);
    expect(result.events.map((event) => event.eventId)).toEqual([first.eventId, second.eventId]);
    expect(result.events.map((event) => event.eventType)).toEqual([
      "task_started",
      "validation_done",
    ]);
    expect(resolveTaskLedgerPath()).toBe(
      path.join(testStateDir, "session-recovery", "task-ledger.jsonl"),
    );
  });

  it("redacts sensitive ledger text before writing", () => {
    appendTaskLedgerEvent({
      taskId: "task-secret",
      actorType: "user",
      actorId: "user-1",
      eventType: "handoff_written",
      summary: "Token api_key=sk_test_12345678901234567890 should not persist",
      sourceRefs: ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz"],
      sensitivityLevel: "sensitive",
    });

    const result = readTaskLedgerEvents();

    expect(result.events[0]?.summary).toContain("[REDACTED]");
    expect(result.events[0]?.summary).not.toContain("sk_test");
    expect(result.events[0]?.sourceRefs[0]).toContain("[REDACTED]");
  });

  it("loads valid events and counts invalid jsonl lines", async () => {
    const ledgerPath = resolveTaskLedgerPath();
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.writeFile(
      ledgerPath,
      [
        JSON.stringify({
          schemaVersion: 1,
          eventId: "evt_1",
          taskId: "task-a",
          createdAt: "2026-04-26T21:23:00.000Z",
          actorType: "agent",
          actorId: "avery",
          eventType: "task_started",
          summary: "ok",
          confidence: "confirmed",
          sourceRefs: [],
          sensitivityLevel: "internal",
          approvalRequired: false,
          approvalStatus: "not_required",
        }),
        "not-json",
        JSON.stringify({ schemaVersion: 1, eventId: "missing-fields" }),
      ].join("\n"),
    );

    const result = readTaskLedgerEvents();

    expect(result.events).toHaveLength(1);
    expect(result.invalidLines).toBe(2);
  });

  it("saves and loads recovery bundles with sanitized prompt input", () => {
    const bundle = saveRecoveryBundle({
      taskId: "task/recovery mvp",
      status: "candidate",
      workspaceId: "workspace-a",
      repoId: "repo-a",
      confirmedItems: ["Patch hash verified", `Expected hash ${LOCKFILE_PATCH_HASH}`],
      uncertainItems: ["Previous session transcript unavailable"],
      missingItems: ["User has not confirmed continuation"],
      expiredApprovals: ["Prior install approval expired"],
      nextResumeAction: "Ask user to confirm continuation before running tests",
      now: new Date("2026-04-26T21:23:00.000Z"),
    });

    const loaded = loadRecoveryBundle("task/recovery mvp");
    const promptInput = buildSessionRecoveryPromptInputFromBundle({
      bundle: loaded,
      nowMs: Date.parse("2026-04-26T21:30:00.000Z"),
    });

    expect(resolveRecoveryBundlePath("task/recovery mvp")).toBe(
      path.join(testStateDir, "session-recovery", "bundles", "task_recovery_mvp.json"),
    );
    expect(loaded).toEqual(bundle);
    expect(promptInput).toMatchObject({
      taskId: "task/recovery mvp",
      status: "candidate",
      confirmedItems: ["Patch hash verified", `Expected hash ${LOCKFILE_PATCH_HASH}`],
      expiredApprovals: ["Prior install approval expired"],
    });
  });

  it("marks stale recovery bundles as uncertain context", () => {
    const bundle = saveRecoveryBundle({
      taskId: "task-stale",
      status: "candidate",
      confirmedItems: ["Old summary"],
      now: new Date("2026-04-25T21:23:00.000Z"),
    });

    const promptInput = buildSessionRecoveryPromptInputFromBundle({
      bundle,
      nowMs: Date.parse("2026-04-26T21:23:01.000Z"),
      ttlMs: 1000,
    });

    expect(promptInput?.status).toBe("stale");
    expect(promptInput?.uncertainItems).toContain(
      "Recovery bundle is stale; re-confirm the current task goal.",
    );
  });

  it("redacts standalone sensitive text", () => {
    expect(redactSensitiveText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toContain(
      "[REDACTED]",
    );
  });
});
