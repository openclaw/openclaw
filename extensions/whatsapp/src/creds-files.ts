import path from "node:path";
import {
  assertNoSymlinkParentsSync,
  readRegularFile,
  readRegularFileSync,
  statRegularFileSync,
} from "openclaw/plugin-sdk/security-runtime";

export function resolveWebCredsPath(authDir: string): string {
  return path.join(authDir, "creds.json");
}

export function resolveWebCredsBackupPath(authDir: string): string {
  return path.join(authDir, "creds.json.bak");
}

function assertWebCredsParentPathSafe(filePath: string): void {
  const dir = path.resolve(path.dirname(filePath));
  assertNoSymlinkParentsSync({
    rootDir: path.parse(dir).root,
    targetPath: dir,
    allowMissing: true,
    allowRootChildSymlink: true,
    requireDirectories: true,
    messagePrefix: "WhatsApp credential file path",
  });
}

export function assertWebCredsPathRegularFileOrMissing(filePath: string): void {
  try {
    assertWebCredsParentPathSafe(filePath);
    statRegularFileSync(filePath);
  } catch (error) {
    throw new Error(
      `WhatsApp credential file path is unsafe; creds.json must be a regular file or missing: ${filePath}`,
      { cause: error },
    );
  }
}

export function isWebCredsPathRegularFileOrMissing(filePath: string): boolean {
  try {
    assertWebCredsPathRegularFileOrMissing(filePath);
    return true;
  } catch {
    return false;
  }
}

export function readWebCredsJsonRawSync(filePath: string): string | null {
  try {
    assertWebCredsParentPathSafe(filePath);
    const { buffer, stat } = readRegularFileSync({
      filePath,
    });
    return stat.size > 1 ? buffer.toString("utf-8") : null;
  } catch {
    return null;
  }
}

export async function readWebCredsJsonRaw(filePath: string): Promise<string | null> {
  try {
    assertWebCredsParentPathSafe(filePath);
    const { buffer, stat } = await readRegularFile({
      filePath,
    });
    return stat.size > 1 ? buffer.toString("utf-8") : null;
  } catch {
    return null;
  }
}

export function statWebCredsFileSync(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    assertWebCredsParentPathSafe(filePath);
    const result = statRegularFileSync(filePath);
    if (result.missing || result.stat.size <= 1) {
      return null;
    }
    return {
      mtimeMs: result.stat.mtimeMs,
      size: result.stat.size,
    };
  } catch {
    return null;
  }
}

export function hasWebCredsRegularFileSync(authDir: string): boolean {
  try {
    const credsPath = resolveWebCredsPath(authDir);
    assertWebCredsParentPathSafe(credsPath);
    return !statRegularFileSync(credsPath).missing;
  } catch {
    return false;
  }
}

export function hasWebCredsSync(authDir: string): boolean {
  return statWebCredsFileSync(resolveWebCredsPath(authDir)) !== null;
}
