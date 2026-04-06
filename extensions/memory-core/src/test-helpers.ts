import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

export function createMemoryCoreTestHarness() {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-test-fixtures-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function createTempWorkspace(prefix: string): Promise<string> {
    const workspaceDir = path.join(fixtureRoot, `${prefix}${caseId++}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  return {
    createTempWorkspace,
  };
}
