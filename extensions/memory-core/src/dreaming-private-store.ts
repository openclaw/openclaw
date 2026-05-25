import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside, root } from "openclaw/plugin-sdk/security-runtime";

const DREAMING_ARTIFACTS_RELATIVE_DIR = path.join("memory", ".dreams");
const DREAMING_PRIVATE_FILE_MODE = 0o600;
const DREAMING_PRIVATE_DIR_MODE = 0o700;

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function resolveOpenedDirectoryRealPath(handle: FileHandle, ioPath: string): Promise<string> {
  const handleStat = await handle.stat();
  const fdCandidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
      : [`/dev/fd/${handle.fd}`];
  for (const fdPath of fdCandidates) {
    try {
      const realPath = await fs.realpath(fdPath);
      const realStat = await fs.stat(realPath);
      if (sameFileIdentity(handleStat, realStat)) {
        return realPath;
      }
    } catch {
      // Try the next fd path, then fall back to the original path.
    }
  }
  const realPath = await fs.realpath(ioPath);
  const realStat = await fs.stat(realPath);
  if (!sameFileIdentity(handleStat, realStat)) {
    throw new Error(`Dreaming private artifacts path changed during chmod: ${ioPath}`);
  }
  return realPath;
}

async function chmodDreamingArtifactsDir(scopedRoot: Awaited<ReturnType<typeof root>>): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const artifactsDir = await scopedRoot.resolve(DREAMING_ARTIFACTS_RELATIVE_DIR);
  const noFollowFlag = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const directoryFlag = "O_DIRECTORY" in fsConstants ? fsConstants.O_DIRECTORY : 0;
  const handle = await fs.open(artifactsDir, fsConstants.O_RDONLY | noFollowFlag | directoryFlag);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isDirectory()) {
      throw new Error(`Dreaming private artifacts path must be a directory: ${artifactsDir}`);
    }
    const realPath = await resolveOpenedDirectoryRealPath(handle, artifactsDir);
    if (!isPathInside(scopedRoot.rootWithSep, realPath)) {
      throw new Error(`Dreaming private artifacts path escapes workspace: ${artifactsDir}`);
    }
    await handle.chmod(DREAMING_PRIVATE_DIR_MODE);
    const chmodStat = await handle.stat();
    if ((chmodStat.mode & 0o777) !== DREAMING_PRIVATE_DIR_MODE) {
      throw new Error(
        `Dreaming private artifacts path has insecure permissions ${(chmodStat.mode & 0o777).toString(
          8,
        )}: ${artifactsDir}`,
      );
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function ensureDreamingPrivateArtifactsDir(
  scopedRoot: Awaited<ReturnType<typeof root>>,
): Promise<void> {
  await scopedRoot.mkdir(DREAMING_ARTIFACTS_RELATIVE_DIR);
  await chmodDreamingArtifactsDir(scopedRoot);
}

export async function ensureDreamingPrivateArtifactsDirForWorkspace(
  workspaceDir: string,
): Promise<void> {
  await ensureDreamingPrivateArtifactsDir(await root(workspaceDir, { hardlinks: "reject" }));
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
  return path.join(DREAMING_ARTIFACTS_RELATIVE_DIR, relativePath);
}

export async function readDreamingPrivateJsonIfExists<T = unknown>(
  workspaceDir: string,
  workspaceRelativePath: string,
): Promise<T | null> {
  const scopedRoot = await root(workspaceDir, { hardlinks: "reject" });
  const relativePath = resolveDreamingArtifactPath(workspaceRelativePath);
  try {
    return await scopedRoot.readJson<T>(relativePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "not-found") {
      return null;
    }
    throw err;
  }
}

export async function writeDreamingPrivateJson(
  workspaceDir: string,
  workspaceRelativePath: string,
  value: unknown,
): Promise<void> {
  const scopedRoot = await root(workspaceDir, { hardlinks: "reject" });
  const relativePath = resolveDreamingArtifactPath(workspaceRelativePath);
  await ensureDreamingPrivateArtifactsDir(scopedRoot);
  await scopedRoot.writeJson(relativePath, value, {
    mode: DREAMING_PRIVATE_FILE_MODE,
    trailingNewline: true,
  });
}
