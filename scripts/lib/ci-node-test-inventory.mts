import { matchesGlob } from "node:path";
import { agentVitestProjectOwners } from "../../test/vitest/vitest.agents-paths.mjs";
import { getCliVitestProjectOwner } from "../../test/vitest/vitest.cli-paths.mjs";
import { cliProcessTestFiles } from "../../test/vitest/vitest.cli-process-paths.mjs";
import {
  databaseWorkerCoreTestFiles,
  isDatabaseWorkerCoreTestFile,
} from "../../test/vitest/vitest.database-worker-core-paths.mjs";
import {
  gatewayDatabaseWorkerTestFiles,
  gatewayPluginTestFiles,
  gatewayServerIsolatedTestFiles,
} from "../../test/vitest/vitest.gateway-server-paths.mjs";
import { filterFilesByPatterns } from "../../test/vitest/vitest.include-patterns.ts";
import {
  getUnitFastTestFiles,
  getUnitFastIsolatedTestFiles,
} from "../../test/vitest/vitest.unit-fast-paths.mjs";
import { bundledPluginDependentUnitTestFiles } from "../../test/vitest/vitest.unit-paths.mjs";
import { isStripeEligibleTestFile, listTrackedTestFiles } from "./list-test-files.mts";

export const COMPACT_EMBEDDED_BASE_GROUP_NAME = "agentic-agents-embedded-base";

export function listScopedOwnerTestFiles(owner: {
  root: string;
  include: string[];
  exclude: string[];
}): string[] {
  // Scoped configs drop unit-fast files, so a lister that keeps them prices
  // stripes on files the shard never runs and hands Vitest inert patterns.
  const unitFastFiles = new Set(getUnitFastTestFiles());
  return filterFilesByPatterns(
    listTrackedTestFiles(owner.root).filter((file) =>
      isStripeEligibleTestFile(file, unitFastFiles),
    ),
    owner.include,
    owner.exclude,
    matchesGlob,
  );
}

// Filtering coverage does not make a whole-config owner safe to split.
const WHOLE_CONFIG_FILE_OWNERS = new Map<
  string,
  { listFiles: () => string[]; splitByFile?: false }
>([
  [
    "agentic-gateway-server-isolated",
    { listFiles: () => [...gatewayServerIsolatedTestFiles, ...gatewayDatabaseWorkerTestFiles] },
  ],
  [
    "agentic-cli",
    { listFiles: () => listScopedOwnerTestFiles(getCliVitestProjectOwner()), splitByFile: false },
  ],
  ["agentic-cli-process", { listFiles: () => cliProcessTestFiles }],
  [
    "agentic-agents-support",
    { listFiles: () => listScopedOwnerTestFiles(agentVitestProjectOwners.support) },
  ],
  [
    COMPACT_EMBEDDED_BASE_GROUP_NAME,
    { listFiles: () => listScopedOwnerTestFiles(agentVitestProjectOwners.embedded) },
  ],
  [
    "agentic-plugins",
    {
      listFiles: () =>
        listScopedOwnerTestFiles({
          root: "src/plugins",
          include: ["src/plugins/**/*.test.ts"],
          exclude: [
            "src/plugins/contracts/**",
            "src/plugins/loader.test.ts",
            ...databaseWorkerCoreTestFiles,
          ],
        }),
    },
  ],
  [
    "agentic-plugin-sdk",
    {
      listFiles: () =>
        listScopedOwnerTestFiles({
          root: "src/plugin-sdk",
          include: ["src/plugin-sdk/**/*.test.ts"],
          exclude: [...bundledPluginDependentUnitTestFiles, ...databaseWorkerCoreTestFiles],
        }),
    },
  ],
  [
    "agentic-gateway-methods",
    {
      listFiles: () => [
        ...listScopedOwnerTestFiles({
          root: "src/gateway/server-methods",
          include: ["src/gateway/server-methods/**/*.test.ts"],
          exclude: [...databaseWorkerCoreTestFiles, ...gatewayDatabaseWorkerTestFiles],
        }),
        ...gatewayPluginTestFiles.filter((file) => !gatewayDatabaseWorkerTestFiles.includes(file)),
      ],
    },
  ],
  [
    "core-runtime-config",
    {
      listFiles: () =>
        listTrackedTestFiles("src/config").filter((file) => !isDatabaseWorkerCoreTestFile(file)),
    },
  ],
  // isolate:true gives every file a fresh module graph, so file stripes
  // cannot change behavior.
  ["core-unit-fast-isolated", { listFiles: getUnitFastIsolatedTestFiles }],
]);

const wholeConfigFileCache = new Map<string, string[]>();

export function listWholeConfigFiles(shardName: string): string[] | undefined {
  const listFiles = WHOLE_CONFIG_FILE_OWNERS.get(shardName)?.listFiles;
  if (!listFiles) {
    return undefined;
  }
  // Test fixtures deliberately replace the CLI process inventory. The other
  // owner inventories are immutable for the process lifetime and expensive to
  // rediscover (git walks plus glob matching) on every candidate plan.
  if (shardName === "agentic-cli-process" || shardName === "agentic-cli") {
    return listFiles();
  }
  let files = wholeConfigFileCache.get(shardName);
  if (!files) {
    files = listFiles();
    wholeConfigFileCache.set(shardName, files);
  }
  return files;
}

export function listWholeConfigSplitFiles(shardName: string): string[] | undefined {
  return !canSplitWholeConfigGroup(shardName) ? undefined : listWholeConfigFiles(shardName);
}

export function canSplitWholeConfigGroup(shardName: string): boolean {
  return WHOLE_CONFIG_FILE_OWNERS.get(shardName)?.splitByFile !== false;
}
