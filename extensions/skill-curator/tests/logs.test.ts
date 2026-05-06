import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunLog } from "../src/logs.js";
import type { CuratorRunResult } from "../src/run.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-curator-logs-"));
  tempDirs.push(dir);
  return dir;
}

// Mock HOME to control log output location
const realHome = process.env.HOME;

afterEach(async () => {
  process.env.HOME = realHome;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("writeRunLog", () => {
  it("writes run.json and REPORT.md", async () => {
    const dir = await makeTempDir();
    process.env.HOME = dir; // redirect ~/.openclaw/logs/curator to temp dir

    const result: CuratorRunResult = {
      timestamp: "2026-05-06T12:00:00.000Z",
      snapshotPath: "/tmp/skills.tar.gz",
      transitions: [
        { name: "old-skill", action: "archive", newState: "archived", daysSinceUsed: 100 },
        { name: "stale-skill", action: "mark_stale", newState: "stale", daysSinceUsed: 45 },
      ],
      mutations: [
        { name: "old-skill", action: "archive", oldState: "active", newState: "archived" },
        { name: "stale-skill", action: "mark_stale", oldState: "active", newState: "stale" },
      ],
      dryRun: false,
    };

    const runDir = await writeRunLog(result);
    expect(runDir).toContain(".openclaw/logs/curator/");

    // Verify run.json
    const runJsonPath = path.join(runDir, "run.json");
    const runJsonRaw = await fs.readFile(runJsonPath, "utf-8");
    const runJson = JSON.parse(runJsonRaw);
    expect(runJson.dryRun).toBe(false);
    expect(runJson.transitions).toHaveLength(2);
    expect(runJson.mutations).toHaveLength(2);
    expect(runJson.snapshotPath).toBe("/tmp/skills.tar.gz");

    // Verify REPORT.md
    const reportPath = path.join(runDir, "REPORT.md");
    const report = await fs.readFile(reportPath, "utf-8");
    expect(report).toContain("# Curator Run Report");
    expect(report).toContain("LIVE");
    expect(report).toContain("old-skill");
    expect(report).toContain("stale-skill");
    expect(report).toContain("## 📦 Snapshot");
    expect(report).toContain("## ✏️ Mutations");
  });

  it("marks dry run in report", async () => {
    const dir = await makeTempDir();
    process.env.HOME = dir;

    const result: CuratorRunResult = {
      timestamp: "2026-05-06T12:00:00.000Z",
      snapshotPath: null,
      transitions: [],
      mutations: [],
      dryRun: true,
    };

    const runDir = await writeRunLog(result);
    const report = await fs.readFile(path.join(runDir, "REPORT.md"), "utf-8");
    expect(report).toContain("DRY RUN");
    expect(report).toContain("✅ No transitions needed");
  });

  it("reports error when present", async () => {
    const dir = await makeTempDir();
    process.env.HOME = dir;

    const result: CuratorRunResult = {
      timestamp: "2026-05-06T12:00:00.000Z",
      snapshotPath: null,
      transitions: [],
      mutations: [],
      dryRun: false,
      error: "curator paused",
    };

    const runDir = await writeRunLog(result);
    const report = await fs.readFile(path.join(runDir, "REPORT.md"), "utf-8");
    expect(report).toContain("curator paused");
    expect(report).toContain("⚠️ Info");
  });

  it("dry-run writes mutated:false in run.json", async () => {
    const dir = await makeTempDir();
    process.env.HOME = dir;

    const result: CuratorRunResult = {
      timestamp: "2026-05-06T12:00:00.000Z",
      snapshotPath: null,
      transitions: [{ name: "x", action: "archive", newState: "archived", daysSinceUsed: 100 }],
      mutations: [],
      dryRun: true,
    };

    const runDir = await writeRunLog(result);
    const runJson = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf-8"));
    expect(runJson.dryRun).toBe(true);
    expect(runJson.transitions).toHaveLength(1);
    expect(runJson.mutations).toHaveLength(0);
  });
});
