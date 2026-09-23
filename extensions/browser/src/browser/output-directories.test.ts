// Browser tests cover output directories plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureOutputDirectory } from "./output-directories.js";

const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

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
  it("creates nested output directories without changing their names", async () => {
    await withTempDir(async (tempDir) => {
      const names = process.platform === "win32" ? ["downloads"] : ["downloads", "downloads \n"];
      for (const name of names) {
        const outputDir = path.join(tempDir, "reports", name);

        await ensureOutputDirectory(outputDir);

        const stat = await fs.stat(outputDir);
        expect(stat.isDirectory()).toBe(true);
        await ensureOutputDirectory(outputDir);
      }
      await expect(ensureOutputDirectory(path.parse(tempDir).root)).resolves.toBeUndefined();
    });
  });

  it.for(["nested", "existing", "existing/nested"])(
    "rejects symlinked output directory ancestors (%s)",
    async (relativePath, { skip }) => {
      await withTempDir(async (tempDir) => {
        const outsideDir = path.join(tempDir, "outside");
        await fs.mkdir(path.join(outsideDir, "existing"), { recursive: true });
        const symlinkDir = path.join(tempDir, "downloads");
        try {
          await fs.symlink(outsideDir, symlinkDir, directorySymlinkType);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EACCES" || code === "EPERM" || code === "ENOTSUP") {
            skip("directory links are unavailable on this host");
            return;
          }
          throw error;
        }

        await expect(ensureOutputDirectory(path.join(symlinkDir, relativePath))).rejects.toThrow(
          /symlink|output directory/i,
        );
        await expectPathMissing(path.join(outsideDir, "nested"));
        await expectPathMissing(path.join(outsideDir, "existing", "nested"));
      });
    },
  );
});
