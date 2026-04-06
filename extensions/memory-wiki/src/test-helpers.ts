import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import {
  resolveMemoryWikiConfig,
  type MemoryWikiPluginConfig,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { initializeMemoryWikiVault } from "./vault.js";

const MEMORY_WIKI_TEST_HOME = "/Users/tester";

export type MemoryWikiTestVault = {
  rootDir: string;
  config: ResolvedMemoryWikiConfig;
};

export function createMemoryWikiTestHarness() {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempDir(prefix: string): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(tempDir);
    return tempDir;
  }

  async function createVault(options?: {
    prefix?: string;
    rootDir?: string;
    config?: MemoryWikiPluginConfig;
    initialize?: boolean;
  }): Promise<MemoryWikiTestVault> {
    const rootDir =
      options?.rootDir ?? (await createTempDir(options?.prefix ?? "memory-wiki-test-"));
    const config = resolveMemoryWikiConfig(
      {
        ...options?.config,
        vault: {
          ...options?.config?.vault,
          path: rootDir,
        },
      },
      { homedir: MEMORY_WIKI_TEST_HOME },
    );

    if (options?.initialize) {
      await initializeMemoryWikiVault(config);
    }

    return { rootDir, config };
  }

  return {
    createTempDir,
    createVault,
  };
}
