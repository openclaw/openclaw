// Memory Core tests cover dreaming repair plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { auditDreamingArtifacts, repairDreamingArtifacts } from "./dreaming-repair.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";

const tempDirs: string[] = [];

beforeAll(async () => {
  await configureMemoryCoreDreamingStateForTests();
});

afterAll(() => {
  resetMemoryCoreDreamingStateForTests();
});

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
  it("rejects relative workspace paths during audit and repair", async () => {
    await expect(auditDreamingArtifacts({ workspaceDir: "relative/workspace" })).rejects.toThrow(
      "workspaceDir must be an absolute path",
    );
    await expect(repairDreamingArtifacts({ workspaceDir: "relative/workspace" })).rejects.toThrow(
      "workspaceDir must be an absolute path",
    );
  });

  it("clears sqlite session ingestion state when archiving session corpus", async () => {
    const workspaceDir = await createWorkspace();
    const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    await fs.mkdir(sessionCorpusDir, { recursive: true });
    await fs.writeFile(path.join(sessionCorpusDir, "2026-04-11.txt"), "corpus\n", "utf-8");
    await Promise.all([
      writeMemoryCoreWorkspaceEntries({
        namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
        workspaceDir,
        entries: [
          {
            key: "main/session.jsonl",
            value: {
              lastSize: 120,
              lastMtimeMs: 1_000,
              lastContentHash: "hash",
              cursorLine: 42,
            },
          },
        ],
      }),
      writeMemoryCoreWorkspaceEntries({
        namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
        workspaceDir,
        entries: [
          {
            key: "main:0",
            value: { scope: "main", index: 0, hashes: ["message-hash"] },
          },
        ],
      }),
    ]);

    await expect(
      auditDreamingArtifacts({ workspaceDir }).then((audit) => audit.sessionIngestionExists),
    ).resolves.toBe(true);

    const repair = await repairDreamingArtifacts({ workspaceDir });

    expect(repair.archivedSessionCorpus).toBe(true);
    await expect(
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
        workspaceDir,
      }),
    ).resolves.toEqual([]);
    await expect(
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
        workspaceDir,
      }),
    ).resolves.toEqual([]);
    await expect(
      auditDreamingArtifacts({ workspaceDir }).then((audit) => audit.sessionIngestionExists),
    ).resolves.toBe(false);
  });

  it("does not report session ingestion from the SQLite daily namespace", async () => {
    const workspaceDir = await createWorkspace();
    // Only daily ingestion namespace has rows
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
      entries: [
        {
          key: "2026-06-10",
          value: { ingestedAt: Date.now() },
        },
      ],
    });

    const audit = await auditDreamingArtifacts({ workspaceDir });

    expect(audit.sessionIngestionExists).toBe(false);
  });
});
