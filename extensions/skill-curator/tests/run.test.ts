import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideRun,
  curatorRun,
  pauseCurator,
  resumeCurator,
  pinSkill,
  unpinSkill,
  restoreSkill,
  adoptSkill,
  disownSkill,
  type CuratorConfig,
} from "../src/run.js";
import { loadUsage, saveUsage, stampAgentCreated, setPinned } from "../src/telemetry.js";
import type { UsageFile } from "../src/telemetry.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-curator-run-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "skills"), { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const DEFAULT_CONFIG: CuratorConfig = {
  enabled: true,
  interval_hours: 168,
  min_idle_hours: 2,
  stale_after_days: 30,
  archive_after_days: 90,
  backup: { enabled: true, keep: 5 },
};

// ── P1: Trigger logic + first-run defer ─────────────────────────────────────

describe("decideRun", () => {
  it("defers on first run (no last_run_at)", () => {
    const usage: UsageFile = {
      version: 1,
      skills: {},
      updated_at: "2026-01-01T00:00:00.000Z",
      last_run_at: null,
      paused: false,
    };
    const decision = decideRun({ usage, config: DEFAULT_CONFIG, now: new Date() });
    expect(decision.shouldRun).toBe(false);
    expect(decision.firstRun).toBe(true);
    expect(decision.reason).toContain("first-run");
  });

  it("returns false when curator is paused", () => {
    const usage: UsageFile = {
      version: 1,
      skills: {},
      updated_at: "2026-01-01T00:00:00.000Z",
      last_run_at: "2026-01-01T00:00:00.000Z",
      paused: true,
    };
    const decision = decideRun({
      usage,
      config: DEFAULT_CONFIG,
      now: new Date("2026-06-01T00:00:00Z"),
    });
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toContain("paused");
  });

  it("returns false when curator is disabled", () => {
    const usage: UsageFile = {
      version: 1,
      skills: {},
      updated_at: "2026-01-01T00:00:00.000Z",
      last_run_at: "2026-01-01T00:00:00.000Z",
      paused: false,
    };
    const decision = decideRun({
      usage,
      config: { ...DEFAULT_CONFIG, enabled: false },
      now: new Date("2026-06-01T00:00:00Z"),
    });
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toContain("disabled");
  });

  it("returns false when interval not yet met", () => {
    const now = new Date("2026-01-01T06:00:00Z");
    const usage: UsageFile = {
      version: 1,
      skills: {},
      updated_at: "2026-01-01T00:00:00.000Z",
      last_run_at: "2026-01-01T00:00:00.000Z",
      paused: false,
    };
    const decision = decideRun({ usage, config: DEFAULT_CONFIG, now });
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toContain("interval not met");
  });

  it("returns true when interval satisfied", () => {
    const now = new Date("2026-01-08T00:00:00Z"); // 7 days later
    const usage: UsageFile = {
      version: 1,
      skills: {},
      updated_at: "2026-01-01T00:00:00.000Z",
      last_run_at: "2026-01-01T00:00:00.000Z",
      paused: false,
    };
    const decision = decideRun({ usage, config: DEFAULT_CONFIG, now });
    expect(decision.shouldRun).toBe(true);
  });
});

describe("curatorRun — first-run defer", () => {
  it("seeds last_run_at and skips on first run", async () => {
    const dir = await makeTempDir();
    const result = await curatorRun({ workspaceDir: dir, config: DEFAULT_CONFIG });
    expect(result.error).toContain("first-run");
    expect(result.mutations).toHaveLength(0);

    // Verify last_run_at was seeded
    const usage = await loadUsage(dir);
    expect(usage.last_run_at).toBeTruthy();
    expect(usage.last_run_at).not.toBeNull();
  });

  it("does nothing on disabled curator", async () => {
    const dir = await makeTempDir();
    // Manually set last_run_at so it's not a first-run
    const usage = await loadUsage(dir);
    usage.last_run_at = "2026-01-01T00:00:00.000Z";
    await saveUsage(dir, usage);

    const result = await curatorRun({
      workspaceDir: dir,
      config: { ...DEFAULT_CONFIG, enabled: false },
    });
    expect(result.error).toContain("disabled");
    expect(result.mutations).toHaveLength(0);
  });

  it("respects pause flag", async () => {
    const dir = await makeTempDir();
    // Set last_run_at and pause
    const usage = await loadUsage(dir);
    usage.last_run_at = "2026-01-01T00:00:00.000Z";
    usage.paused = true;
    await saveUsage(dir, usage);

    const result = await curatorRun({ workspaceDir: dir, config: DEFAULT_CONFIG });
    expect(result.error).toContain("paused");
    expect(result.mutations).toHaveLength(0);
  });
});

// ── P2: Phase A disk mutations ──────────────────────────────────────────────

describe("curatorRun — disk mutations", () => {
  it("marks stale agent-created skills", async () => {
    const dir = await makeTempDir();
    const now = new Date("2026-05-06T12:00:00Z");
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();

    // Create skill dir (so archive can find it)
    await fs.mkdir(path.join(dir, "skills", "old-skill"), { recursive: true });
    await fs.writeFile(path.join(dir, "skills", "old-skill", "SKILL.md"), "# Old Skill\n");

    // Set up a pre-existing usage file with an agent-created skill last used 40 days ago
    const usage = await loadUsage(dir);
    usage.last_run_at = "2026-01-01T00:00:00.000Z";
    usage.skills["old-skill"] = {
      name: "old-skill",
      view_count: 5,
      use_count: 3,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: fortyDaysAgo,
      last_patched_at: null,
      pinned: false,
      created_at: fortyDaysAgo,
      created_by: "agent",
      created_at_ms: new Date(fortyDaysAgo).getTime(),
      source: "agent-created",
      state: "active",
    };
    await saveUsage(dir, usage);

    // Run curator with a config that has 30d stale threshold
    const result = await curatorRun({
      workspaceDir: dir,
      config: DEFAULT_CONFIG,
      now,
    });

    expect(result.mutations.length).toBeGreaterThanOrEqual(1);
    const mutation = result.mutations.find((m) => m.name === "old-skill");
    expect(mutation).toBeDefined();
    expect(mutation!.action).toBe("mark_stale");
    expect(mutation!.newState).toBe("stale");

    // Verify state was actually written to disk
    const updatedUsage = await loadUsage(dir);
    expect(updatedUsage.skills["old-skill"].state).toBe("stale");
  });

  it("archives very old agent-created skills", async () => {
    const dir = await makeTempDir();
    const now = new Date("2026-05-06T12:00:00Z");
    const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();

    // Create skill dir
    const skillDir = path.join(dir, "skills", "very-old");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Very Old Skill\n");

    const usage = await loadUsage(dir);
    usage.last_run_at = "2026-01-01T00:00:00.000Z";
    usage.skills["very-old"] = {
      name: "very-old",
      view_count: 2,
      use_count: 1,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: hundredDaysAgo,
      last_patched_at: null,
      pinned: false,
      created_at: hundredDaysAgo,
      created_by: "agent",
      created_at_ms: new Date(hundredDaysAgo).getTime(),
      source: "agent-created",
      state: "active",
    };
    await saveUsage(dir, usage);

    const result = await curatorRun({
      workspaceDir: dir,
      config: DEFAULT_CONFIG,
      now,
    });

    const mutation = result.mutations.find((m) => m.name === "very-old");
    expect(mutation).toBeDefined();
    expect(mutation!.action).toBe("archive");
    expect(mutation!.newState).toBe("archived");

    // Verify skill dir was moved to .archive/
    const archiveDir = path.join(dir, "skills", ".archive", "very-old");
    await fs.access(archiveDir); // should exist
    const archivedContent = await fs.readFile(path.join(archiveDir, "SKILL.md"), "utf-8");
    expect(archivedContent).toContain("Very Old Skill");

    // Verify original skill dir is gone
    await expect(fs.access(skillDir)).rejects.toThrow();
  });

  it("skips pinned skills even if old", async () => {
    const dir = await makeTempDir();
    const now = new Date("2026-05-06T12:00:00Z");
    const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();

    const skillDir = path.join(dir, "skills", "pinned-but-old");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Pinned Old\n");

    const usage = await loadUsage(dir);
    usage.last_run_at = "2026-01-01T00:00:00.000Z";
    usage.skills["pinned-but-old"] = {
      name: "pinned-but-old",
      view_count: 2,
      use_count: 1,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: hundredDaysAgo,
      last_patched_at: null,
      pinned: true, // ← pinned
      created_at: hundredDaysAgo,
      created_by: "agent",
      created_at_ms: new Date(hundredDaysAgo).getTime(),
      source: "agent-created",
      state: "active",
    };
    await saveUsage(dir, usage);

    const result = await curatorRun({
      workspaceDir: dir,
      config: DEFAULT_CONFIG,
      now,
    });

    // Should have no mutations for pinned skill
    const mutation = result.mutations.find((m) => m.name === "pinned-but-old");
    expect(mutation).toBeUndefined();

    // Skill dir should still exist
    await fs.access(skillDir);
  });

  it("skips user-created skills", async () => {
    const dir = await makeTempDir();
    const now = new Date("2026-05-06T12:00:00Z");
    const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();

    const skillDir = path.join(dir, "skills", "user-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# User Skill\n");

    const usage = await loadUsage(dir);
    usage.last_run_at = "2026-01-01T00:00:00.000Z";
    usage.skills["user-skill"] = {
      name: "user-skill",
      view_count: 2,
      use_count: 1,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: hundredDaysAgo,
      last_patched_at: null,
      pinned: false,
      created_at: hundredDaysAgo,
      created_by: "user", // ← user-created
      created_at_ms: null,
      source: "agent-created",
      state: "active",
    };
    await saveUsage(dir, usage);

    const result = await curatorRun({ workspaceDir: dir, config: DEFAULT_CONFIG, now });

    const mutation = result.mutations.find((m) => m.name === "user-skill");
    expect(mutation).toBeUndefined();
    await fs.access(skillDir); // should still exist
  });

  it("skips bundled skills", async () => {
    const dir = await makeTempDir();
    const now = new Date("2026-05-06T12:00:00Z");
    const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();

    const usage = await loadUsage(dir);
    usage.last_run_at = "2026-01-01T00:00:00.000Z";
    usage.skills["bundled-skill"] = {
      name: "bundled-skill",
      view_count: 2,
      use_count: 1,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: hundredDaysAgo,
      last_patched_at: null,
      pinned: false,
      created_at: hundredDaysAgo,
      created_by: "agent",
      created_at_ms: new Date(hundredDaysAgo).getTime(),
      source: "bundled",
      state: "active",
    };
    await saveUsage(dir, usage);

    const result = await curatorRun({ workspaceDir: dir, config: DEFAULT_CONFIG, now });
    const mutation = result.mutations.find((m) => m.name === "bundled-skill");
    expect(mutation).toBeUndefined();
  });

  it("creates snapshot before mutation", async () => {
    const dir = await makeTempDir();
    const now = new Date("2026-05-06T12:00:00Z");
    const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();

    const skillDir = path.join(dir, "skills", "snap-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Snapshot Test\n");

    const usage = await loadUsage(dir);
    usage.last_run_at = "2026-01-01T00:00:00.000Z";
    usage.skills["snap-skill"] = {
      name: "snap-skill",
      view_count: 2,
      use_count: 1,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: hundredDaysAgo,
      last_patched_at: null,
      pinned: false,
      created_at: hundredDaysAgo,
      created_by: "agent",
      created_at_ms: new Date(hundredDaysAgo).getTime(),
      source: "agent-created",
      state: "active",
    };
    await saveUsage(dir, usage);

    const result = await curatorRun({
      workspaceDir: dir,
      config: DEFAULT_CONFIG,
      now,
    });

    expect(result.snapshotPath).toBeTruthy();
    expect(result.snapshotPath).toContain(".curator_backups");
    expect(result.snapshotPath).toMatch(/skills\.tar\.gz$/);

    // Verify snapshot file exists
    await fs.access(result.snapshotPath!);
  });

  it("lockfile prevents concurrent runs", async () => {
    const dir = await makeTempDir();
    // Manually create the lockfile to simulate concurrent run
    const lockPath = path.join(dir, "skills", ".curator_backups", ".in-progress");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "12345\ndummy\n");

    const usage = await loadUsage(dir);
    usage.last_run_at = "2026-01-01T00:00:00.000Z";
    await saveUsage(dir, usage);

    const now = new Date("2026-06-01T00:00:00Z"); // 5 months later — interval satisfied

    const result = await curatorRun({
      workspaceDir: dir,
      config: DEFAULT_CONFIG,
      now,
    });

    expect(result.error).toContain("lockfile");
    expect(result.mutations).toHaveLength(0);
  });

  it("dry-run does not mutate or create lockfile", async () => {
    const dir = await makeTempDir();
    const now = new Date("2026-05-06T12:00:00Z");
    const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();

    const skillDir = path.join(dir, "skills", "dry-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Dry Run Test\n");

    const usage = await loadUsage(dir);
    usage.last_run_at = "2026-01-01T00:00:00.000Z";
    usage.skills["dry-skill"] = {
      name: "dry-skill",
      view_count: 2,
      use_count: 1,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: hundredDaysAgo,
      last_patched_at: null,
      pinned: false,
      created_at: hundredDaysAgo,
      created_by: "agent",
      created_at_ms: new Date(hundredDaysAgo).getTime(),
      source: "agent-created",
      state: "active",
    };
    await saveUsage(dir, usage);

    const result = await curatorRun({
      workspaceDir: dir,
      config: DEFAULT_CONFIG,
      now,
      dryRun: true,
    });

    // Should report mutations but not apply them
    const mutation = result.mutations.find((m) => m.name === "dry-skill");
    expect(mutation).toBeDefined();
    expect(mutation!.action).toBe("archive");

    // Skill dir should still exist (not moved)
    await fs.access(skillDir);

    // State should NOT have changed on disk
    const updatedUsage = await loadUsage(dir);
    expect(updatedUsage.skills["dry-skill"].state).toBe("active");

    // No lockfile residue
    const lockPath = path.join(dir, "skills", ".curator_backups", ".in-progress");
    await expect(fs.access(lockPath)).rejects.toThrow();
  });
});

// ── pinSkill / unpinSkill ───────────────────────────────────────────────────

describe("pinSkill / unpinSkill", () => {
  it("pinSkill sets pinned=true", async () => {
    const dir = await makeTempDir();
    const usage = await loadUsage(dir);
    usage.skills["test"] = {
      name: "test",
      view_count: 0,
      use_count: 0,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: null,
      last_patched_at: null,
      pinned: false,
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "agent",
      created_at_ms: 1700000000000,
      source: "agent-created",
      state: "active",
    };
    await saveUsage(dir, usage);

    await pinSkill(dir, "test");
    const loaded = await loadUsage(dir);
    expect(loaded.skills["test"].pinned).toBe(true);
  });

  it("unpinSkill sets pinned=false", async () => {
    const dir = await makeTempDir();
    const usage = await loadUsage(dir);
    usage.skills["test"] = {
      name: "test",
      view_count: 0,
      use_count: 0,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: null,
      last_patched_at: null,
      pinned: true,
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "agent",
      created_at_ms: 1700000000000,
      source: "agent-created",
      state: "active",
    };
    await saveUsage(dir, usage);

    await unpinSkill(dir, "test");
    const loaded = await loadUsage(dir);
    expect(loaded.skills["test"].pinned).toBe(false);
  });
});

// ── pauseCurator / resumeCurator ────────────────────────────────────────────

describe("pauseCurator / resumeCurator", () => {
  it("pause sets paused flag", async () => {
    const dir = await makeTempDir();
    await pauseCurator(dir);
    const usage = await loadUsage(dir);
    expect(usage.paused).toBe(true);
  });

  it("resume clears paused flag", async () => {
    const dir = await makeTempDir();
    // Pause first
    const usage = await loadUsage(dir);
    usage.paused = true;
    await saveUsage(dir, usage);

    await resumeCurator(dir);
    const updated = await loadUsage(dir);
    expect(updated.paused).toBe(false);
  });
});

// ── adoptSkill / disownSkill ───────────────────────────────────────────────

describe("adoptSkill / disownSkill", () => {
  it("adopt sets created_by='agent'", async () => {
    const dir = await makeTempDir();
    const usage = await loadUsage(dir);
    usage.skills["my-skill"] = {
      name: "my-skill",
      view_count: 0,
      use_count: 0,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: null,
      last_patched_at: null,
      pinned: false,
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "unknown",
      created_at_ms: null,
      source: "agent-created",
      state: "active",
    };
    await saveUsage(dir, usage);

    await adoptSkill(dir, "my-skill");
    const loaded = await loadUsage(dir);
    expect(loaded.skills["my-skill"].created_by).toBe("agent");
  });

  it("disown sets created_by='user'", async () => {
    const dir = await makeTempDir();
    const usage = await loadUsage(dir);
    usage.skills["my-skill"] = {
      name: "my-skill",
      view_count: 0,
      use_count: 0,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: null,
      last_patched_at: null,
      pinned: false,
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "agent",
      created_at_ms: 1700000000000,
      source: "agent-created",
      state: "active",
    };
    await saveUsage(dir, usage);

    await disownSkill(dir, "my-skill");
    const loaded = await loadUsage(dir);
    expect(loaded.skills["my-skill"].created_by).toBe("user");
  });

  it("adopt → disown round-trip works", async () => {
    const dir = await makeTempDir();
    const usage = await loadUsage(dir);
    usage.skills["test"] = {
      name: "test",
      view_count: 0,
      use_count: 0,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: null,
      last_patched_at: null,
      pinned: false,
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "unknown",
      created_at_ms: null,
      source: "agent-created",
      state: "active",
    };
    await saveUsage(dir, usage);

    await adoptSkill(dir, "test");
    expect((await loadUsage(dir)).skills["test"].created_by).toBe("agent");

    await disownSkill(dir, "test");
    expect((await loadUsage(dir)).skills["test"].created_by).toBe("user");
  });
});

// ── restoreSkill ────────────────────────────────────────────────────────────

describe("restoreSkill", () => {
  it("moves skill from .archive/ back to skills/ and sets active", async () => {
    const dir = await makeTempDir();
    const archivePath = path.join(dir, "skills", ".archive", "restored-skill");
    await fs.mkdir(archivePath, { recursive: true });
    await fs.writeFile(path.join(archivePath, "SKILL.md"), "# Restored\n");

    // Set up usage with skill in archived state
    const usage = await loadUsage(dir);
    usage.skills["restored-skill"] = {
      name: "restored-skill",
      view_count: 2,
      use_count: 1,
      patch_count: 0,
      last_viewed_at: null,
      last_used_at: "2026-01-01T00:00:00.000Z",
      last_patched_at: null,
      pinned: false,
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "agent",
      created_at_ms: 1700000000000,
      source: "agent-created",
      state: "archived",
    };
    await saveUsage(dir, usage);

    await restoreSkill(dir, "restored-skill");

    // Verify moved back
    const restoredDir = path.join(dir, "skills", "restored-skill");
    await fs.access(restoredDir);
    const content = await fs.readFile(path.join(restoredDir, "SKILL.md"), "utf-8");
    expect(content).toContain("Restored");

    // Verify state reset to active
    const updated = await loadUsage(dir);
    expect(updated.skills["restored-skill"].state).toBe("active");

    // Archive dir should be gone
    await expect(fs.access(archivePath)).rejects.toThrow();
  });
});
