import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractArchive } from "openclaw/plugin-sdk/archive";
import { readFileWithinRoot, removePathWithinRoot } from "openclaw/plugin-sdk/file-access-runtime";
import { DIR_FETCH_ARCHIVE_POLICY } from "../shared/dir-fetch-archive.js";
import { skillSourceArchive } from "../shared/workspace-skill-source.js";

export async function retireSkillSource(workspace: string, source: unknown) {
  const archive = skillSourceArchive(workspace, source);
  await removePathWithinRoot({
    rootDir: workspace,
    relativePath: path.relative(workspace, archive),
    force: true,
  });
}

/** Extract a private, bounded copy; the native worker never opens a caller-selected source. */
export async function prepareSkillSource(workspace: string, source: unknown) {
  const archive = skillSourceArchive(workspace, source);
  const uploadRoot = path.join(os.homedir(), ".cache/openclaw/skill-installs");
  await fs.mkdir(uploadRoot, { recursive: true, mode: 0o700 });
  const extractedRoot = await fs.mkdtemp(path.join(uploadRoot, "node-"));
  const privateArchive = `${extractedRoot}.tgz`;
  try {
    const { buffer } = await readFileWithinRoot({
      rootDir: workspace,
      relativePath: path.relative(workspace, archive),
      maxBytes: DIR_FETCH_ARCHIVE_POLICY.limits.maxArchiveBytes,
    });
    await fs.writeFile(privateArchive, buffer, { mode: 0o600 });
    await extractArchive({
      archivePath: privateArchive,
      destDir: extractedRoot,
      kind: "tar",
      tarGzip: true,
      timeoutMs: 60_000,
      durable: false,
      ...DIR_FETCH_ARCHIVE_POLICY,
    });
    return { extractedRoot, cleanup: () => fs.rm(extractedRoot, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(extractedRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await fs.rm(privateArchive, { force: true });
  }
}
