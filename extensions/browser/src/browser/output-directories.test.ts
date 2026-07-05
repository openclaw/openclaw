// Browser tests cover output directories plugin behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureOutputDirectory } from "./output-directories.js";

const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

const canCreateDirectorySymlinks = (() => {
  let probeDir: string | undefined;
  try {
    probeDir = fsSync.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-output-dir-symlink-probe-"),
    );
    const targetDir = path.join(probeDir, "target");
    const linkDir = path.join(probeDir, "link");
    fsSync.mkdirSync(targetDir);
    fsSync.symlinkSync(targetDir, linkDir, directorySymlinkType);
    return true;
  } catch {
    return false;
  } finally {
    if (probeDir) {
      try {
        fsSync.rmSync(probeDir, { recursive: true, force: true });
      } catch {}
    }
  }
})();

async function withTempDir<T>(run: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-output-dir-test-"));
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let error: unknown;
  try {
    await fs.access(targetPath);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
}

describe("ensureOutputDirectory", () => {
  it("creates nested missing output directories", async () => {
    await withTempDir(async (tempDir) => {
      const outputDir = path.join(tempDir, "reports", "downloads");

      await ensureOutputDirectory(outputDir);

      const stat = await fs.stat(outputDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  it.skipIf(!canCreateDirectorySymlinks)(
    "rejects symlinked output directory ancestors",
    async () => {
      await withTempDir(async (tempDir) => {
        const outsideDir = path.join(tempDir, "outside");
        await fs.mkdir(outsideDir);
        const symlinkDir = path.join(tempDir, "downloads");
        await fs.symlink(outsideDir, symlinkDir, directorySymlinkType);

        await expect(ensureOutputDirectory(path.join(symlinkDir, "nested"))).rejects.toThrow(
          /symlink|output directory/i,
        );
        await expectPathMissing(path.join(outsideDir, "nested"));
      });
    },
  );
});
