import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function createTempDirHarness() {
  const tempDirs: string[] = [];

  return {
    async cleanup() {
      await Promise.all(
        tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
      );
    },
    async makeTempDir(prefix: string) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    },
  };
}
