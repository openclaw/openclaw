import fs from "node:fs/promises";
import path from "node:path";
import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";

const DREAMING_ARTIFACTS_RELATIVE_DIR = path.join("memory", ".dreams");

function resolveDreamingArtifactsDir(workspaceDir: string): string {
  return path.join(workspaceDir, DREAMING_ARTIFACTS_RELATIVE_DIR);
}

async function assertNoSymlinkedDreamingStoreParents(workspaceDir: string): Promise<void> {
  for (const relativePath of ["memory", DREAMING_ARTIFACTS_RELATIVE_DIR]) {
    const target = path.join(workspaceDir, relativePath);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked dreaming private store path: ${relativePath}`);
    }
  }
}

function resolveDreamingArtifactPath(workspaceRelativePath: string): string {
  const relativePath = path.relative(DREAMING_ARTIFACTS_RELATIVE_DIR, workspaceRelativePath);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      `Dreaming private artifact path must be under memory/.dreams: ${workspaceRelativePath}`,
    );
  }
  return relativePath;
}

export async function readDreamingPrivateJsonIfExists<T = unknown>(
  workspaceDir: string,
  workspaceRelativePath: string,
): Promise<T | null> {
  await assertNoSymlinkedDreamingStoreParents(workspaceDir);
  return await privateFileStore(resolveDreamingArtifactsDir(workspaceDir)).readJsonIfExists<T>(
    resolveDreamingArtifactPath(workspaceRelativePath),
  );
}

export async function writeDreamingPrivateJson(
  workspaceDir: string,
  workspaceRelativePath: string,
  value: unknown,
): Promise<void> {
  await assertNoSymlinkedDreamingStoreParents(workspaceDir);
  await privateFileStore(resolveDreamingArtifactsDir(workspaceDir)).writeJson(
    resolveDreamingArtifactPath(workspaceRelativePath),
    value,
    { trailingNewline: true },
  );
}
