import fs from "node:fs";
import path from "node:path";

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

export function writeSecretRefDocsFile(repoRoot: string, filePath: string, content: string): void {
  const fd = openDocsFile(repoRoot, filePath, fs.constants.O_WRONLY);
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}
