import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDailyDreamingPhaseBlock, writeDeepDreamingReport } from "./dreaming-markdown.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dreaming-markdown-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("dreaming markdown storage", () => {
  it("writes inline light dreaming output into top-level dreams.md", async () => {
    const workspaceDir = await createTempWorkspace();

    const result = await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: remember the API key is fake"],
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    expect(result.inlinePath).toBe(path.join(workspaceDir, "dreams.md"));
    const content = await fs.readFile(result.inlinePath!, "utf-8");
    expect(content).toContain("## Light Sleep");
    expect(content).toContain("- Candidate: remember the API key is fake");
  });

  it("keeps multiple inline phases in the shared top-level dreams.md file", async () => {
    const workspaceDir = await createTempWorkspace();

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: first block"],
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });
    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "rem",
      bodyLines: ["- Theme: `focus` kept surfacing."],
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const dreamsPath = path.join(workspaceDir, "dreams.md");
    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toContain("## Light Sleep");
    expect(content).toContain("## REM Sleep");
    expect(content).toContain("- Candidate: first block");
    expect(content).toContain("- Theme: `focus` kept surfacing.");
  });

  it("still writes deep reports to the per-phase report directory", async () => {
    const workspaceDir = await createTempWorkspace();

    const reportPath = await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Promoted: durable preference"],
      storage: {
        mode: "separate",
        separateReports: false,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    expect(reportPath).toBe(path.join(workspaceDir, "memory", "dreaming", "deep", "2026-04-05.md"));
    const content = await fs.readFile(reportPath!, "utf-8");
    expect(content).toContain("# Deep Sleep");
    expect(content).toContain("- Promoted: durable preference");
  });
});
