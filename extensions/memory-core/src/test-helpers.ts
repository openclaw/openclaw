import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

export function createMemoryCoreTestHarness() {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempWorkspace(prefix: string): Promise<string> {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(workspaceDir);
    return workspaceDir;
  }

  return {
    createTempWorkspace,
  };
}
