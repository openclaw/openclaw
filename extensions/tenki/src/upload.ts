import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Tar a local directory into a buffer for staging via the session file API.
 *
 * The tree is validated first so the remote extract can never recreate
 * symlinks that escape the uploaded workspace (GHSA-fv94-qvg8-xqpw).
 */
export async function createLocalTarball(localDir: string): Promise<Buffer> {
  await assertSafeUploadSymlinks(localDir);
  return await new Promise<Buffer>((resolve, reject) => {
    const tar = spawn("tar", ["-C", localDir, "-cf", "-", "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const stderr: Buffer[] = [];
    tar.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    tar.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tar failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function assertSafeUploadSymlinks(localDir: string): Promise<void> {
  const realRoot = await fs.realpath(path.resolve(localDir));
  await walkDirectory(realRoot);

  async function walkDirectory(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = await fs.realpath(entryPath);
        } catch {
          // Dangling target: canonicalize the deepest existing ancestor of the
          // link target so alias prefixes (e.g. macOS /var -> /private/var)
          // still compare against the canonical root.
          const target = await fs.readlink(entryPath);
          resolved = await canonicalizeViaExistingAncestor(path.resolve(currentDir, target));
        }
        if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
          const relativePath = path.relative(realRoot, entryPath).split(path.sep).join("/");
          throw new Error(
            `Tenki sandbox upload refuses symlink escaping the workspace: ${relativePath}`,
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walkDirectory(entryPath);
      }
    }
  }
}

async function canonicalizeViaExistingAncestor(absolutePath: string): Promise<string> {
  let base = absolutePath;
  const suffix: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(base);
      return suffix.length > 0 ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(base);
      if (parent === base) {
        return absolutePath;
      }
      suffix.unshift(path.basename(base));
      base = parent;
    }
  }
}
