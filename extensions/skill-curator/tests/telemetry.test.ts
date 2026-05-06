import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  incrementUse,
  incrementView,
  incrementPatch,
  loadUsage,
  saveUsage,
  setPinned,
  stampAgentCreated,
  setCreatedBy,
  isAgentCreated,
  setLastRunAt,
  setPaused,
  shouldRunCurator,
  type UsageFile,
} from "../src/telemetry.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-curator-telemetry-"));
  tempDirs.push(dir);
  // Create skills/ subdirectory
  await fs.mkdir(path.join(dir, "skills"), { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("telemetry", () => {
  it("loadUsage returns empty file for a fresh workspace", async () => {
    const dir = await makeTempDir();
    const usage = await loadUsage(dir);
    expect(usage.version).toBe(1);
    expect(usage.skills).toEqual({});
    expect(usage.last_run_at).toBeNull();
    expect(usage.paused).toBe(false);
  });

  it("incrementView creates entry and bumps view_count", async () => {
    const dir = await makeTempDir();
    const entry = await incrementView(dir, "my-skill");
    expect(entry.name).toBe("my-skill");
    expect(entry.view_count).toBe(1);
    expect(entry.use_count).toBe(0);
    expect(entry.patch_count).toBe(0);
    expect(entry.last_viewed_at).toBeTruthy();
    // New entries default to "unknown" until agent stamps them
    expect(entry.created_by).toBe("unknown");
    expect(entry.created_at_ms).toBeNull();

    // Reload and verify persistence
    const usage = await loadUsage(dir);
    expect(usage.skills["my-skill"]).toBeDefined();
    expect(usage.skills["my-skill"].view_count).toBe(1);
    expect(usage.skills["my-skill"].created_by).toBe("unknown");
  });

  it("incrementView accumulates across calls", async () => {
    const dir = await makeTempDir();
    await incrementView(dir, "my-skill");
    await incrementView(dir, "my-skill");
    await incrementView(dir, "my-skill");

    const entry = await incrementView(dir, "my-skill");
    expect(entry.view_count).toBe(4);
  });

  it("incrementUse bumps use_count and last_used_at", async () => {
    const dir = await makeTempDir();
    const entry = await incrementUse(dir, "my-skill");
    expect(entry.use_count).toBe(1);
    expect(entry.last_used_at).toBeTruthy();
    expect(entry.view_count).toBe(0);

    const entry2 = await incrementUse(dir, "my-skill");
    expect(entry2.use_count).toBe(2);
  });

  it("incrementPatch bumps patch_count and last_patched_at", async () => {
    const dir = await makeTempDir();
    const entry = await incrementPatch(dir, "my-skill");
    expect(entry.patch_count).toBe(1);
    expect(entry.last_patched_at).toBeTruthy();
  });

  it("saveUsage + loadUsage round-trip preserves all fields", async () => {
    const dir = await makeTempDir();
    const usage: UsageFile = {
      version: 1,
      skills: {
        "test-skill": {
          name: "test-skill",
          view_count: 5,
          use_count: 3,
          patch_count: 1,
          last_viewed_at: "2026-05-01T12:00:00.000Z",
          last_used_at: "2026-04-15T09:00:00.000Z",
          last_patched_at: "2026-04-10T08:00:00.000Z",
          pinned: false,
          created_at: "2026-01-01T00:00:00.000Z",
          created_by: "agent",
          created_at_ms: 1700000000000,
          source: "agent-created",
          state: "active",
        },
      },
      updated_at: "2026-05-06T12:00:00.000Z",
      last_run_at: null,
      paused: false,
    };

    await saveUsage(dir, usage);
    const loaded = await loadUsage(dir);

    expect(loaded.skills["test-skill"]).toBeDefined();
    expect(loaded.skills["test-skill"].view_count).toBe(5);
    expect(loaded.skills["test-skill"].use_count).toBe(3);
    expect(loaded.skills["test-skill"].patch_count).toBe(1);
    expect(loaded.skills["test-skill"].last_viewed_at).toBe("2026-05-01T12:00:00.000Z");
    expect(loaded.skills["test-skill"].last_used_at).toBe("2026-04-15T09:00:00.000Z");
    expect(loaded.skills["test-skill"].state).toBe("active");
    expect(loaded.skills["test-skill"].created_by).toBe("agent");
    expect(loaded.skills["test-skill"].created_at_ms).toBe(1700000000000);
  });

  it("pinned:true survives a load/save cycle", async () => {
    const dir = await makeTempDir();

    // Create and pin a skill
    const entry = await incrementUse(dir, "pinned-skill");
    expect(entry.pinned).toBe(false);

    const pinnedEntry = await setPinned(dir, "pinned-skill", true);
    expect(pinnedEntry.pinned).toBe(true);

    // Reload — pinned should survive
    const usage = await loadUsage(dir);
    expect(usage.skills["pinned-skill"].pinned).toBe(true);

    // Modify something else and save again — pinned must persist
    await incrementView(dir, "pinned-skill");
    const usage2 = await loadUsage(dir);
    expect(usage2.skills["pinned-skill"].pinned).toBe(true);
    expect(usage2.skills["pinned-skill"].view_count).toBe(1);
    expect(usage2.skills["pinned-skill"].use_count).toBe(1);
  });

  it("unpinning sets pinned back to false", async () => {
    const dir = await makeTempDir();
    await setPinned(dir, "pinned-skill", true);
    const pinned = await loadUsage(dir);
    expect(pinned.skills["pinned-skill"].pinned).toBe(true);

    await setPinned(dir, "pinned-skill", false);
    const unpinned = await loadUsage(dir);
    expect(unpinned.skills["pinned-skill"].pinned).toBe(false);
  });

  it("atomic write does not corrupt on disk", async () => {
    const dir = await makeTempDir();
    await saveUsage(dir, {
      version: 1,
      skills: {
        a: {
          name: "a",
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
        },
      },
      updated_at: "2026-01-01T00:00:00.000Z",
      last_run_at: null,
      paused: false,
    });

    // Should load without issues
    const loaded = await loadUsage(dir);
    expect(loaded.skills.a.name).toBe("a");

    // Verify no tmp files left behind
    const skillsDir = path.join(dir, "skills");
    const files = await fs.readdir(skillsDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  describe("created_by marker", () => {
    it("stampAgentCreated sets created_by='agent' and created_at_ms", async () => {
      const dir = await makeTempDir();
      // First, create an entry via incrementUse
      const entry = await incrementUse(dir, "agent-skill");
      expect(entry.created_by).toBe("unknown");

      // Stamp it
      const stamped = await stampAgentCreated(dir, "agent-skill");
      expect(stamped.created_by).toBe("agent");
      expect(stamped.created_at_ms).toBeTruthy();
      expect(typeof stamped.created_at_ms).toBe("number");

      // Persists
      const usage = await loadUsage(dir);
      expect(usage.skills["agent-skill"].created_by).toBe("agent");
      expect(typeof usage.skills["agent-skill"].created_at_ms).toBe("number");
    });

    it("setCreatedBy changes created_by", async () => {
      const dir = await makeTempDir();
      await stampAgentCreated(dir, "test-skill");

      await setCreatedBy(dir, "test-skill", "user");
      let usage = await loadUsage(dir);
      expect(usage.skills["test-skill"].created_by).toBe("user");

      await setCreatedBy(dir, "test-skill", "agent");
      usage = await loadUsage(dir);
      expect(usage.skills["test-skill"].created_by).toBe("agent");
    });

    it("isAgentCreated returns true only for 'agent'", async () => {
      const dir = await makeTempDir();
      await stampAgentCreated(dir, "agent-skill");
      const usage = await loadUsage(dir);

      expect(isAgentCreated(usage.skills["agent-skill"])).toBe(true);
    });

    it("loadUsage migrates entries missing created_by to 'unknown'", async () => {
      const dir = await makeTempDir();
      // Write a legacy file without created_by fields
      const legacy = {
        version: 1,
        skills: {
          "legacy-skill": {
            name: "legacy-skill",
            view_count: 3,
            use_count: 1,
            patch_count: 0,
            last_viewed_at: null,
            last_used_at: "2026-01-01T00:00:00.000Z",
            last_patched_at: null,
            pinned: false,
            created_at: "2026-01-01T00:00:00.000Z",
            source: "agent-created",
            state: "active",
          },
        },
        updated_at: "2026-01-01T00:00:00.000Z",
      };
      const usagePath = path.join(dir, "skills", ".usage.json");
      await fs.writeFile(usagePath, JSON.stringify(legacy, null, 2));

      const loaded = await loadUsage(dir);
      expect(loaded.skills["legacy-skill"].created_by).toBe("unknown");
      expect(loaded.skills["legacy-skill"].created_at_ms).toBeNull();
      expect(loaded.last_run_at).toBeNull();
      expect(loaded.paused).toBe(false);
    });
  });

  describe("meta fields", () => {
    it("setLastRunAt persists last_run_at", async () => {
      const dir = await makeTempDir();
      const ts = "2026-05-06T14:00:00.000Z";
      await setLastRunAt(dir, ts);
      const usage = await loadUsage(dir);
      expect(usage.last_run_at).toBe(ts);
    });

    it("setPaused persists paused flag", async () => {
      const dir = await makeTempDir();
      await setPaused(dir, true);
      let usage = await loadUsage(dir);
      expect(usage.paused).toBe(true);

      await setPaused(dir, false);
      usage = await loadUsage(dir);
      expect(usage.paused).toBe(false);
    });
  });

  describe("shouldRunCurator", () => {
    it("returns false on first run (null last_run_at)", () => {
      const result = shouldRunCurator({
        lastRunAt: null,
        intervalHours: 168,
        now: new Date(),
      });
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toContain("first-run");
    });

    it("returns false when interval not met", () => {
      const now = new Date("2026-05-06T12:00:00Z");
      const result = shouldRunCurator({
        lastRunAt: "2026-05-06T11:00:00Z", // 1 hour ago
        intervalHours: 168, // 7 days
        now,
      });
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toContain("interval not met");
    });

    it("returns true when interval satisfied", () => {
      const now = new Date("2026-05-13T12:00:00Z");
      const result = shouldRunCurator({
        lastRunAt: "2026-05-06T12:00:00Z", // 7 days ago
        intervalHours: 168, // 7 days
        now,
      });
      expect(result.shouldRun).toBe(true);
      expect(result.reason).toContain("interval satisfied");
    });

    it("returns true when interval exceeded", () => {
      const now = new Date("2026-05-20T12:00:00Z");
      const result = shouldRunCurator({
        lastRunAt: "2026-05-06T12:00:00Z", // 14 days ago
        intervalHours: 168,
        now,
      });
      expect(result.shouldRun).toBe(true);
    });
  });
});
