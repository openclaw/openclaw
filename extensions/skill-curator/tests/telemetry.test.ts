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
  });

  it("incrementView creates entry and bumps view_count", async () => {
    const dir = await makeTempDir();
    const entry = await incrementView(dir, "my-skill");
    expect(entry.name).toBe("my-skill");
    expect(entry.view_count).toBe(1);
    expect(entry.use_count).toBe(0);
    expect(entry.patch_count).toBe(0);
    expect(entry.last_viewed_at).toBeTruthy();

    // Reload and verify persistence
    const usage = await loadUsage(dir);
    expect(usage.skills["my-skill"]).toBeDefined();
    expect(usage.skills["my-skill"].view_count).toBe(1);
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
          source: "agent-created",
          state: "active",
        },
      },
      updated_at: "2026-05-06T12:00:00.000Z",
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
          source: "agent-created",
          state: "active",
        },
      },
      updated_at: "2026-01-01T00:00:00.000Z",
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
});
