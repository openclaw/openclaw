import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
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

const sessionNamespaces = [
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
];
const seedNamespace = (workspaceDir: string, namespace: string) =>
  writeMemoryCoreWorkspaceEntries({
    namespace,
    workspaceDir,
    entries: [{ key: "fixture", value: {} }],
  });

it("rejects relative workspace paths during audit and repair", async () => {
  for (const run of [auditDreamingArtifacts, repairDreamingArtifacts]) {
    await expect(run({ workspaceDir: "relative/workspace" })).rejects.toThrow(
      "workspaceDir must be an absolute path",
    );
  }
});

it("clears sqlite session ingestion state when archiving session corpus", async () => {
  const workspaceDir = await createTempWorkspace("dreaming-repair-test-");
  const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
  await fs.mkdir(sessionCorpusDir, { recursive: true });
  await fs.writeFile(path.join(sessionCorpusDir, "2026-04-11.txt"), "corpus\n", "utf-8");
  await Promise.all(sessionNamespaces.map((namespace) => seedNamespace(workspaceDir, namespace)));

  await expect(
    auditDreamingArtifacts({ workspaceDir }).then((audit) => audit.sessionIngestionExists),
  ).resolves.toBe(true);

  const repair = await repairDreamingArtifacts({ workspaceDir });

  expect(repair.archivedSessionCorpus).toBe(true);
  for (const namespace of sessionNamespaces) {
    await expect(readMemoryCoreWorkspaceEntries({ namespace, workspaceDir })).resolves.toEqual([]);
  }
  await expect(
    auditDreamingArtifacts({ workspaceDir }).then((audit) => audit.sessionIngestionExists),
  ).resolves.toBe(false);
});

it("does not report session ingestion from the SQLite daily namespace", async () => {
  const workspaceDir = await createTempWorkspace("dreaming-repair-test-");
  await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
  await seedNamespace(workspaceDir, DREAMING_DAILY_INGESTION_NAMESPACE);

  const audit = await auditDreamingArtifacts({ workspaceDir });

  expect(audit.sessionIngestionExists).toBe(false);
});
