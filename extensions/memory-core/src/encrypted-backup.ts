import fs from "node:fs/promises";
import path from "node:path";
import ageInit from "age-encryption";

export type MemoryBackupFile = {
  path: string;
  data: string;
  mode?: number;
  mtimeMs?: number;
};

export type MemoryBackupArchive = {
  version: 1;
  createdAt: string;
  sourceWorkspaceDir: string;
  files: MemoryBackupFile[];
};

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function assertSafeRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("..")) {
    throw new Error(`Unsafe backup path: ${relativePath}`);
  }
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  let rootStat;
  try {
    rootStat = await fs.lstat(rootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to back up symlinked memory directory: ${rootDir}`);
  }
  if (!rootStat.isDirectory()) {
    return [];
  }
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function collectMemoryBackupArchive(params: {
  workspaceDir: string;
  now?: Date;
}): Promise<MemoryBackupArchive> {
  const workspaceDir = path.resolve(params.workspaceDir);
  const candidateFiles = [
    path.join(workspaceDir, "MEMORY.md"),
    path.join(workspaceDir, "DREAMS.md"),
    ...(await listFilesRecursive(path.join(workspaceDir, "memory"))),
  ];
  const files: MemoryBackupFile[] = [];
  const seen = new Set<string>();
  for (const filePath of candidateFiles) {
    const resolvedPath = path.resolve(filePath);
    const relativePath = normalizeRelativePath(path.relative(workspaceDir, resolvedPath));
    if (seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    assertSafeRelativePath(relativePath);
    let stat;
    try {
      stat = await fs.lstat(resolvedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
    }
    if (!stat.isFile()) {
      continue;
    }
    files.push({
      path: relativePath,
      data: (await fs.readFile(resolvedPath)).toString("base64"),
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
    });
  }
  return {
    version: 1,
    createdAt: (params.now ?? new Date()).toISOString(),
    sourceWorkspaceDir: workspaceDir,
    files: files.toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

export async function encryptMemoryBackupArchive(
  archive: MemoryBackupArchive,
  passphrase: string,
): Promise<Buffer> {
  if (!passphrase) {
    throw new Error("Memory backup passphrase is required.");
  }
  const { Encrypter } = await ageInit();
  const plaintext = JSON.stringify(archive);
  const encrypter = new Encrypter();
  encrypter.setPassphrase(passphrase);
  const ciphertext = encrypter.encrypt(new TextEncoder().encode(plaintext));
  return Buffer.from(ciphertext);
}

export async function decryptMemoryBackupArchive(
  input: Buffer,
  passphrase: string,
): Promise<MemoryBackupArchive> {
  if (!passphrase) {
    throw new Error("Memory backup passphrase is required.");
  }
  const { Decrypter } = await ageInit();
  const decrypter = new Decrypter();
  decrypter.addPassphrase(passphrase);
  const decrypted = decrypter.decrypt(new Uint8Array(input));
  const plaintext = new TextDecoder().decode(decrypted);
  const archive = JSON.parse(plaintext) as Partial<MemoryBackupArchive>;
  if (archive.version !== 1 || !Array.isArray(archive.files)) {
    throw new Error("Unsupported memory backup archive.");
  }
  for (const file of archive.files) {
    assertSafeRelativePath(file.path);
  }
  return archive as MemoryBackupArchive;
}

async function assertNoSymlinkParents(targetDir: string, outputPath: string): Promise<void> {
  const relativeDir = path.relative(targetDir, path.dirname(outputPath));
  if (!relativeDir) {
    return;
  }
  let current = targetDir;
  for (const segment of relativeDir.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to restore through symlinked directory: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}

async function assertNotSymlinkLeaf(outputPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(outputPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlinked file: ${outputPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

export async function writeMemoryBackupArchive(params: {
  archive: MemoryBackupArchive;
  targetDir: string;
  overwrite?: boolean;
}): Promise<number> {
  const targetDir = path.resolve(params.targetDir);
  let written = 0;
  for (const file of params.archive.files) {
    assertSafeRelativePath(file.path);
    const outputPath = path.resolve(targetDir, file.path);
    if (!outputPath.startsWith(`${targetDir}${path.sep}`)) {
      throw new Error(`Backup path escapes target directory: ${file.path}`);
    }
    if (!params.overwrite) {
      try {
        await fs.lstat(outputPath);
        throw new Error(`Refusing to overwrite existing file: ${outputPath}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }
    await assertNoSymlinkParents(targetDir, outputPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await assertNoSymlinkParents(targetDir, outputPath);
    await assertNotSymlinkLeaf(outputPath);
    await fs.writeFile(outputPath, Buffer.from(file.data, "base64"), {
      mode: file.mode,
      flag: params.overwrite ? "w" : "wx",
    });
    if (typeof file.mtimeMs === "number") {
      const mtime = new Date(file.mtimeMs);
      await fs.utimes(outputPath, mtime, mtime);
    }
    written += 1;
  }
  return written;
}
