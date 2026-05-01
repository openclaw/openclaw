import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTempDirTracker(prefix: string): {
  create(): Promise<string>;
  cleanup(): Promise<void>;
} {
  const tempDirs: string[] = [];
  return {
    async create() {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    },
    async cleanup() {
      await Promise.all(
        tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
      );
    },
  };
}
