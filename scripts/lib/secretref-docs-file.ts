import fs from "node:fs";
import path from "node:path";
import { root as fsRoot } from "@openclaw/fs-safe/root";

function assertDocsFile(repoRoot: string, filePath: string): fs.Stats {
  const docsRoot = path.join(repoRoot, "docs");
  const referenceRoot = path.join(docsRoot, "reference");
  if (
    path.dirname(filePath) !== referenceRoot ||
    !fs.lstatSync(docsRoot).isDirectory() ||
    !fs.lstatSync(referenceRoot).isDirectory() ||
    fs.realpathSync(referenceRoot) !== path.join(fs.realpathSync(repoRoot), "docs", "reference")
  ) {
    throw new Error(`Unsafe docs path: ${filePath}`);
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Expected a regular docs file: ${filePath}`);
  }
  return stat;
}

function openDocsFile(repoRoot: string, filePath: string, flags: number): number {
  const original = assertDocsFile(repoRoot, filePath);
  const fd = fs.openSync(filePath, flags | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== original.dev || opened.ino !== original.ino) {
      throw new Error(`Docs file changed: ${filePath}`);
    }
    assertDocsFile(repoRoot, filePath);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function readSecretRefDocsFile(repoRoot: string, filePath: string): string {
  const fd = openDocsFile(repoRoot, filePath, fs.constants.O_RDONLY);
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export async function writeSecretRefDocsFile(
  repoRoot: string,
  filePath: string,
  content: string,
): Promise<void> {
  const original = assertDocsFile(repoRoot, filePath);
  const referenceRoot = path.dirname(filePath);
  const root = await fsRoot(referenceRoot, {
    hardlinks: "reject",
    mutationSymlinks: "reject",
    symlinks: "reject",
  });
  await root.write(path.basename(filePath), content, {
    assertBeforeMutation: () => {
      const current = assertDocsFile(repoRoot, filePath);
      if (current.dev !== original.dev || current.ino !== original.ino) {
        throw new Error(`Docs file changed: ${filePath}`);
      }
    },
    durable: true,
    mode: original.mode & 0o777,
    mutationSymlinks: "reject",
    overwrite: true,
  });
  const installed = assertDocsFile(repoRoot, filePath);
  if (installed.dev === original.dev && installed.ino === original.ino) {
    throw new Error(`Docs file was not replaced: ${filePath}`);
  }
}
