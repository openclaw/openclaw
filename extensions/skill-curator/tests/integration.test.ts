import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunLog } from "../src/logs.js";
import { curatorRun, restoreSkill, type CuratorConfig } from "../src/run.js";
import { loadUsage, saveUsage, stampAgentCreated, type UsageFile } from "../src/telemetry.js";

const DEFAULT_CONFIG: CuratorConfig = {
  enabled: true,
  interval_hours: 168,
  min_idle_hours: 2,
  stale_after_days: 30,
  archive_after_days: 90,
  backup: { enabled: true, keep: 5 },
};

async function setupFixtureWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-curator-fixture-"));
  const skillsDir = path.join(dir, "skills");
  await fs.mkdir(skillsDir, { recursive: true });

  // 1. Bundled skill (excluded from all curator actions)
  const bundledDir = path.join(skillsDir, "bundled-tool");
  await fs.mkdir(bundledDir, { recursive: true });
  await fs.writeFile(path.join(bundledDir, "SKILL.md"), "# Bundled Tool\n\nBuilt-in skill.\n");
  await fs.writeFile(path.join(bundledDir, ".bundled_manifest"), "{}");

  // 2. Hub-installed skill (excluded)
  const hubDir = path.join(skillsDir, "hub-plugin");
  await fs.mkdir(hubDir, { recursive: true });
  await fs.writeFile(path.join(hubDir, "SKILL.md"), "# Hub Plugin\n\nFrom clawhub.\n");

  // 3. User-authored skill (created_by: user — excluded)
  const userDir = path.join(skillsDir, "my-notes");
  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(path.join(userDir, "SKILL.md"), "# My Notes\n\nPersonal workflow.\n");

  // 4. Agent-created but pinned (excluded)
  const pinnedDir = path.join(skillsDir, "pinned-workflow");
  await fs.mkdir(pinnedDir, { recursive: true });
  await fs.writeFile(
    path.join(pinnedDir, "SKILL.md"),
    "# Pinned Workflow\n\nImportant agent workflow.\n",
  );

  // 5. Two agent-created OLD skills (should be archived)
  const old1Dir = path.join(skillsDir, "old-workflow-1");
  await fs.mkdir(old1Dir, { recursive: true });
  await fs.writeFile(path.join(old1Dir, "SKILL.md"), "# Old Workflow 1\n\nVery old.\n");

  const old2Dir = path.join(skillsDir, "old-workflow-2");
  await fs.mkdir(old2Dir, { recursive: true });
  await fs.writeFile(path.join(old2Dir, "SKILL.md"), "# Old Workflow 2\n\nAlso very old.\n");

  // 6. Agent-created RECENT skill (should be kept)
  const recentDir = path.join(skillsDir, "recent-workflow");
  await fs.mkdir(recentDir, { recursive: true });
  await fs.writeFile(path.join(recentDir, "SKILL.md"), "# Recent Workflow\n\nRecently used.\n");

  // Set up usage.json
  const now = new Date("2026-05-06T12:00:00Z");
  const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();
  const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const ms = now.getTime();

  const usage: UsageFile = {
    version: 1,
    skills: {
      "bundled-tool": {
        name: "bundled-tool",
        view_count: 10,
        use_count: 5,
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
      },
      "hub-plugin": {
        name: "hub-plugin",
        view_count: 10,
        use_count: 5,
        patch_count: 0,
        last_viewed_at: null,
        last_used_at: hundredDaysAgo,
        last_patched_at: null,
        pinned: false,
        created_at: hundredDaysAgo,
        created_by: "agent",
        created_at_ms: new Date(hundredDaysAgo).getTime(),
        source: "hub",
        state: "active",
      },
      "my-notes": {
        name: "my-notes",
        view_count: 3,
        use_count: 1,
        patch_count: 0,
        last_viewed_at: null,
        last_used_at: hundredDaysAgo,
        last_patched_at: null,
        pinned: false,
        created_at: hundredDaysAgo,
        created_by: "user",
        created_at_ms: null,
        source: "agent-created",
        state: "active",
      },
      "pinned-workflow": {
        name: "pinned-workflow",
        view_count: 20,
        use_count: 15,
        patch_count: 0,
        last_viewed_at: null,
        last_used_at: hundredDaysAgo,
        last_patched_at: null,
        pinned: true,
        created_at: hundredDaysAgo,
        created_by: "agent",
        created_at_ms: new Date(hundredDaysAgo).getTime(),
        source: "agent-created",
        state: "active",
      },
      "old-workflow-1": {
        name: "old-workflow-1",
        view_count: 5,
        use_count: 2,
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
      },
      "old-workflow-2": {
        name: "old-workflow-2",
        view_count: 3,
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
      },
      "recent-workflow": {
        name: "recent-workflow",
        view_count: 8,
        use_count: 6,
        patch_count: 0,
        last_viewed_at: null,
        last_used_at: tenDaysAgo,
        last_patched_at: null,
        pinned: false,
        created_at: hundredDaysAgo,
        created_by: "agent",
        created_at_ms: new Date(hundredDaysAgo).getTime(),
        source: "agent-created",
        state: "active",
      },
    },
    updated_at: "2026-05-06T12:00:00.000Z",
    last_run_at: "2026-01-01T00:00:00.000Z", // interval satisfied
    paused: false,
  };

  await saveUsage(dir, usage);
  return dir;
}

describe("curator integration test", () => {
  it("dry-run: proposes right actions, zero mutations on disk", async () => {
    const dir = await setupFixtureWorkspace();
    const now = new Date("2026-05-06T12:00:00Z");

    const result = await curatorRun({
      workspaceDir: dir,
      config: DEFAULT_CONFIG,
      dryRun: true,
      now,
    });

    // Should propose archiving the two old agent-created skills
    const archiveMutations = result.mutations.filter((m) => m.action === "archive");
    expect(archiveMutations).toHaveLength(2);
    const archivedNames = archiveMutations.map((m) => m.name).sort();
    expect(archivedNames).toEqual(["old-workflow-1", "old-workflow-2"]);

    // Recent workflow should NOT be archived (only 10 days)
    const recentMutation = result.mutations.find((m) => m.name === "recent-workflow");
    expect(recentMutation).toBeUndefined();

    // Pinned skill should NOT be touched
    const pinnedMutation = result.mutations.find((m) => m.name === "pinned-workflow");
    expect(pinnedMutation).toBeUndefined();

    // User-authored should NOT be touched
    const userMutation = result.mutations.find((m) => m.name === "my-notes");
    expect(userMutation).toBeUndefined();

    // Bundled should NOT be touched
    const bundledMutation = result.mutations.find((m) => m.name === "bundled-tool");
    expect(bundledMutation).toBeUndefined();

    // Hub should NOT be touched
    const hubMutation = result.mutations.find((m) => m.name === "hub-plugin");
    expect(hubMutation).toBeUndefined();

    // Zero on-disk mutations
    const skillsDir = path.join(dir, "skills");
    const entries = await fs.readdir(skillsDir);
    // All original skill dirs should still exist
    expect(entries).toContain("old-workflow-1");
    expect(entries).toContain("old-workflow-2");
    expect(entries).toContain("recent-workflow");
    expect(entries).toContain("pinned-workflow");
    expect(entries).toContain("my-notes");
    expect(entries).toContain("bundled-tool");
    expect(entries).toContain("hub-plugin");

    // No .archive/ dir should have been created
    await expect(fs.access(path.join(skillsDir, ".archive"))).rejects.toThrow();

    // Usage state should not have changed
    const usage = await loadUsage(dir);
    expect(usage.skills["old-workflow-1"].state).toBe("active");
    expect(usage.skills["old-workflow-2"].state).toBe("active");

    // Cleanup
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("sync run: archives old skills, keeps pinned, writes report", async () => {
    const dir = await setupFixtureWorkspace();
    const now = new Date("2026-05-06T12:00:00Z");

    const result = await curatorRun({
      workspaceDir: dir,
      config: DEFAULT_CONFIG,
      dryRun: false,
      now,
    });

    // Should have archived the two old skills
    const archiveMutations = result.mutations.filter((m) => m.action === "archive");
    expect(archiveMutations).toHaveLength(2);

    // Snapshot should exist
    expect(result.snapshotPath).toBeTruthy();
    await fs.access(result.snapshotPath!);

    // Old skills should have moved to .archive/
    const archiveDir = path.join(dir, "skills", ".archive");
    await fs.access(path.join(archiveDir, "old-workflow-1"));
    await fs.access(path.join(archiveDir, "old-workflow-2"));

    // Old skill dirs should be gone from skills/
    const skillsDir = path.join(dir, "skills");
    await expect(fs.access(path.join(skillsDir, "old-workflow-1"))).rejects.toThrow();
    await expect(fs.access(path.join(skillsDir, "old-workflow-2"))).rejects.toThrow();

    // Pinned skill should still exist
    await fs.access(path.join(skillsDir, "pinned-workflow"));
    const pinnedContent = await fs.readFile(
      path.join(skillsDir, "pinned-workflow", "SKILL.md"),
      "utf-8",
    );
    expect(pinnedContent).toContain("Pinned Workflow");

    // User-authored should still exist
    await fs.access(path.join(skillsDir, "my-notes"));

    // Recent skill should still exist
    await fs.access(path.join(skillsDir, "recent-workflow"));

    // Bundled should still exist
    await fs.access(path.join(skillsDir, "bundled-tool"));

    // Hub should still exist
    await fs.access(path.join(skillsDir, "hub-plugin"));

    // Usage state should be updated
    const usage = await loadUsage(dir);
    expect(usage.skills["old-workflow-1"].state).toBe("archived");
    expect(usage.skills["old-workflow-2"].state).toBe("archived");
    expect(usage.skills["pinned-workflow"].state).toBe("active");
    expect(usage.skills["recent-workflow"].state).toBe("active");

    // last_run_at should be updated
    expect(usage.last_run_at).toBeTruthy();

    // Write run log and verify REPORT.md
    const runDir = await writeRunLog(result);
    const report = await fs.readFile(path.join(runDir, "REPORT.md"), "utf-8");
    expect(report).toContain("LIVE");
    expect(report).toContain("old-workflow-1");
    expect(report).toContain("old-workflow-2");

    // Cleanup
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("restore brings archived skill back", async () => {
    const dir = await setupFixtureWorkspace();
    const now = new Date("2026-05-06T12:00:00Z");

    // First, run to archive old-workflow-1
    await curatorRun({ workspaceDir: dir, config: DEFAULT_CONFIG, dryRun: false, now });

    // Verify it's archived
    const archivePath = path.join(dir, "skills", ".archive", "old-workflow-1");
    await fs.access(archivePath);

    // Restore it
    await restoreSkill(dir, "old-workflow-1");

    // Should be back in skills/
    const restoredPath = path.join(dir, "skills", "old-workflow-1");
    await fs.access(restoredPath);
    const content = await fs.readFile(path.join(restoredPath, "SKILL.md"), "utf-8");
    expect(content).toContain("Old Workflow 1");

    // Archive dir should be gone
    await expect(fs.access(archivePath)).rejects.toThrow();

    // State should be active
    const usage = await loadUsage(dir);
    expect(usage.skills["old-workflow-1"].state).toBe("active");

    // Cleanup
    await fs.rm(dir, { recursive: true, force: true });
  });
});
