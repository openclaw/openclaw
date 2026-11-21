// Prompt Snapshot Files script supports OpenClaw repository automation.
import fs from "node:fs/promises";
import path from "node:path";
import { GENERATED_PROMPT_SNAPSHOT_DIRS } from "../test/helpers/agents/prompt-snapshot-paths.js";

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export async function listCommittedSnapshotArtifactPaths(root: string): Promise<string[]> {
  const snapshots = await Promise.all(
    GENERATED_PROMPT_SNAPSHOT_DIRS.map((directory) => listSnapshotDirectory(root, directory)),
  );
  return snapshots.flat();
}

async function listSnapshotDirectory(root: string, directory: string): Promise<string[]> {
  let committedEntries: string[];
  try {
    committedEntries = await fs.readdir(path.resolve(root, directory));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    committedEntries = [];
  }
  return committedEntries
    .filter((entry) => /\.(?:json|md(?:\.(?:diff|patch))?)$/u.test(entry))
    .map((entry) => path.join(directory, entry));
}

export async function deleteStalePromptSnapshotFiles(
  root: string,
  files: Array<{ path: string }>,
): Promise<string[]> {
  const expectedPaths = new Set(files.map((file) => file.path));
  const stalePaths = (await listCommittedSnapshotArtifactPaths(root)).filter(
    (snapshotPath) => !expectedPaths.has(snapshotPath),
  );
  await Promise.all(stalePaths.map((snapshotPath) => fs.rm(path.resolve(root, snapshotPath))));
  return stalePaths;
}
