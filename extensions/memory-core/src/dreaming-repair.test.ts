import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditDreamingArtifacts, repairDreamingArtifacts } from "./dreaming-repair.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

async function createWorkspace(): Promise<string> {
  const workspaceDir = await createTempWorkspace("dreaming-repair-test-");
  await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
  return workspaceDir;
}

describe("dreaming artifact repair", () => {
  it("rejects relative workspace paths during audit and repair", async () => {
    for (const run of [auditDreamingArtifacts, repairDreamingArtifacts]) {
      await expect(run({ workspaceDir: "relative/workspace" })).rejects.toThrow(
        "workspaceDir must be an absolute path",
      );
    }
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
        entries: [{ key: "main:0", value: { scope: "main", index: 0, hashes: ["message-hash"] } }],
      }),
    ]);

    await expect(
      auditDreamingArtifacts({ workspaceDir }).then((audit) => audit.sessionIngestionExists),
    ).resolves.toBe(true);

    const repair = await repairDreamingArtifacts({ workspaceDir });

    expect(repair.archivedSessionCorpus).toBe(true);
    for (const namespace of [
      DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
    ]) {
      await expect(readMemoryCoreWorkspaceEntries({ namespace, workspaceDir })).resolves.toEqual(
        [],
      );
    }
    await expect(
      auditDreamingArtifacts({ workspaceDir }).then((audit) => audit.sessionIngestionExists),
    ).resolves.toBe(false);
  });

  it("does not report session ingestion from the SQLite daily namespace", async () => {
    const workspaceDir = await createWorkspace();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
      entries: [{ key: "2026-06-10", value: { ingestedAt: Date.now() } }],
    });

    const audit = await auditDreamingArtifacts({ workspaceDir });

    expect(audit.sessionIngestionExists).toBe(false);
  });
});
