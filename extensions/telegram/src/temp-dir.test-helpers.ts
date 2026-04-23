import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function createSuiteTempRootTracker(options: { prefix: string; parentDir?: string }) {
  let root = "";
  let nextIndex = 0;

  return {
    async setup(): Promise<string> {
      root = await fs.mkdtemp(path.join(options.parentDir ?? os.tmpdir(), options.prefix));
      nextIndex = 0;
      return root;
    },
    async make(prefix = "case"): Promise<string> {
      const dir = path.join(root, `${prefix}-${nextIndex++}`);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    async cleanup(): Promise<void> {
      if (!root) {
        return;
      }
      const currentRoot = root;
      root = "";
      nextIndex = 0;
      await fs.rm(currentRoot, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      });
    },
  };
}
