import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditDreamingArtifacts, repairDreamingArtifacts } from "./dreaming-repair.js";

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dreaming-repair-test-"));
  tempDirs.push(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
  return workspaceDir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("dreaming artifact repair", () => {
  it("detects self-ingested dreaming corpus lines", async () => {
    const workspaceDir = await createWorkspace();
    await fs
      .writeFile(
        path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-11.txt"),
        [
          "[main/dreaming-main.jsonl#L4] regular session text",
          "[main/dreaming-narrative-light.jsonl#L1] Write a dream diary entry from these memory fragments:",
        ].join("\n"),
        "utf-8",
      )
      .catch(async () => {
        await fs.mkdir(path.join(workspaceDir, "memory", ".dreams", "session-corpus"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-11.txt"),
          [
            "[main/dreaming-main.jsonl#L4] regular session text",
            "[main/dreaming-narrative-light.jsonl#L1] Write a dream diary entry from these memory fragments:",
          ].join("\n"),
          "utf-8",
        );
      });

    const audit = await auditDreamingArtifacts({ workspaceDir });

    expect(audit.sessionCorpusFileCount).toBe(1);
    expect(audit.suspiciousSessionCorpusFileCount).toBe(1);
    expect(audit.suspiciousSessionCorpusLineCount).toBe(1);
    expect(audit.issues).toEqual([
      expect.objectContaining({
        code: "dreaming-session-corpus-self-ingested",
        fixable: true,
      }),
    ]);
  });

  it("archives derived dreaming artifacts without touching the diary by default", async () => {
    const workspaceDir = await createWorkspace();
    const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    await fs.mkdir(sessionCorpusDir, { recursive: true });
    await fs.writeFile(path.join(sessionCorpusDir, "2026-04-11.txt"), "corpus\n", "utf-8");
    await fs.writeFile(
      path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json"),
      JSON.stringify({ version: 3, files: {}, seenMessages: {} }, null, 2),
      "utf-8",
    );
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Dream Diary\n", "utf-8");

    const repair = await repairDreamingArtifacts({
      workspaceDir,
      now: new Date("2026-04-11T21:30:00.000Z"),
    });

    expect(repair.changed).toBe(true);
    expect(repair.archivedSessionCorpus).toBe(true);
    expect(repair.archivedSessionIngestion).toBe(true);
    expect(repair.archivedDreamsDiary).toBe(false);
    expect(repair.archiveDir).toBe(
      path.join(workspaceDir, ".openclaw-repair", "dreaming", "2026-04-11T21-30-00-000Z"),
    );
    await expect(fs.access(sessionCorpusDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(dreamsPath, "utf-8")).resolves.toContain("# Dream Diary");
    await expect(
      fs.access(path.join(repair.archiveDir!, "session-corpus", "2026-04-11.txt")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(repair.archiveDir!, "session-ingestion.json")),
    ).resolves.toBeUndefined();
  });
});
