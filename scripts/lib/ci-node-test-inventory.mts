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
  gatewayCoreTestInclude,
  gatewayCoreTestExclude,
  gatewayClientTestInclude,
  gatewayClientTestExclude,
  gatewayMethodsTestInclude,
  gatewayMethodsTestExclude,
  gatewayMethodsIsolatedTestFiles,
} from "../../test/vitest/vitest.gateway-server-paths.mjs";
import { filterFilesByPatterns } from "../../test/vitest/vitest.include-patterns.ts";
import {
  autoReplyCoreTestInclude,
  autoReplyCoreTestExclude,
  autoReplyTopLevelReplyTestInclude,
} from "../../test/vitest/vitest.test-shards.mjs";
import {
  getUnitFastTestFiles,
  getUnitFastIsolatedTestFiles,
} from "../../test/vitest/vitest.unit-fast-paths.mjs";
import {
  bundledPluginDependentUnitTestFiles,
  filterUnitConfigTestFiles,
} from "../../test/vitest/vitest.unit-paths.mjs";
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
  // Node 24 recompiles matchesGlob for every file. Plain canonical test paths
  // need only equality; keep all glob/escape/dot-segment syntax with Node.
  const literalPatterns = new Set(
    [...owner.include, ...owner.exclude].filter((pattern) =>
      /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.test\.ts$/u.test(pattern),
    ),
  );
  return filterFilesByPatterns(
    listTrackedTestFiles(owner.root).filter((file) =>
      isStripeEligibleTestFile(file, unitFastFiles),
    ),
    owner.include,
    owner.exclude,
    (file, pattern) =>
      literalPatterns.has(pattern) ? file === pattern : matchesGlob(file, pattern),
  );
}

const CONFIG_FILE_OWNERS = new Map<string, Parameters<typeof listScopedOwnerTestFiles>[0]>([
  [
    "test/vitest/vitest.gateway-methods.config.ts",
    {
      root: ".",
      include: [...gatewayMethodsTestInclude],
      exclude: [...gatewayMethodsTestExclude],
    },
  ],
  [
    "test/vitest/vitest.gateway-methods-isolated.config.ts",
    {
      root: ".",
      include: [...gatewayMethodsIsolatedTestFiles],
      exclude: [],
    },
  ],
  [
    "test/vitest/vitest.auto-reply-core.config.ts",
    {
      root: "src/auto-reply",
      include: [...autoReplyCoreTestInclude],
      exclude: [...autoReplyCoreTestExclude, ...databaseWorkerCoreTestFiles],
    },
  ],
  [
    "test/vitest/vitest.auto-reply-top-level.config.ts",
    {
      root: "src/auto-reply",
      include: [...autoReplyTopLevelReplyTestInclude],
      exclude: [],
    },
  ],
  [
    "test/vitest/vitest.gateway-core.config.ts",
    {
      root: "src/gateway",
      include: [...gatewayCoreTestInclude],
      exclude: [...gatewayCoreTestExclude],
    },
  ],
  [
    "test/vitest/vitest.gateway-client.config.ts",
    {
      root: ".",
      include: [...gatewayClientTestInclude],
      exclude: [...gatewayClientTestExclude],
    },
  ],
]);
const EXACT_CONFIG_FILES = new Map<string, string[]>([
  ["test/vitest/vitest.gateway-server-isolated.config.ts", gatewayServerIsolatedTestFiles],
  ["test/vitest/vitest.gateway-database-workers.config.ts", gatewayDatabaseWorkerTestFiles],
]);
const configFileCache = new Map<string, string[]>();

/** Disjoint project inventories retain exact ownership within shared process groups. */
export function listNodeTestConfigFiles(config: string): string[] | undefined {
  const exact = EXACT_CONFIG_FILES.get(config);
  if (exact) {
    return exact;
  }
  const owner = CONFIG_FILE_OWNERS.get(config);
  if (!owner) {
    return undefined;
  }
  let files = configFileCache.get(config);
  if (!files) {
    files = listScopedOwnerTestFiles(owner);
    configFileCache.set(config, files);
  }
  return files;
}

// Filtering coverage does not make a whole-config owner safe to split.
const WHOLE_CONFIG_FILE_OWNERS = new Map<
  string,
  { listFiles: () => string[]; splitByFile?: false }
>([
  [
    "core-unit-src-security-support",
    {
      listFiles: () =>
        filterUnitConfigTestFiles(
          listScopedOwnerTestFiles({
            root: "src/security",
            include: ["src/security/**/*.test.ts"],
            exclude: [],
          }),
        ),
      splitByFile: false,
    },
  ],
  [
    "core-unit-support",
    {
      listFiles: () =>
        filterUnitConfigTestFiles(
          listScopedOwnerTestFiles({
            root: "packages",
            include: ["packages/**/*.test.ts"],
            exclude: [],
          }),
        ),
      splitByFile: false,
    },
  ],
  [
    "agentic-gateway-server-isolated",
    { listFiles: () => [...gatewayServerIsolatedTestFiles, ...gatewayDatabaseWorkerTestFiles] },
  ],
  ["agentic-cli", { listFiles: () => listScopedOwnerTestFiles(getCliVitestProjectOwner()) }],
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
