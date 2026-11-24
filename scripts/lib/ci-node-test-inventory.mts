import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { matchesGlob } from "node:path";
import {
  agentVitestProjectOwners,
  embeddedAgentVitestProjectOwners,
} from "../../test/vitest/vitest.agents-paths.mjs";
import { getCliVitestProjectOwner } from "../../test/vitest/vitest.cli-paths.mjs";
import { cliProcessTestFiles } from "../../test/vitest/vitest.cli-process-paths.mjs";
import { commandsLightTestFiles } from "../../test/vitest/vitest.commands-light-paths.mjs";
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
import {
  filterFilesByPatterns,
  isPlainRepoRelativePath,
} from "../../test/vitest/vitest.include-patterns.ts";
import { markdownTestFiles } from "../../test/vitest/vitest.markdown-paths.mjs";
import { isSharedVitestExcludedPath } from "../../test/vitest/vitest.pattern-file.ts";
import {
  autoReplyCoreTestInclude,
  autoReplyCoreTestExclude,
  autoReplyTopLevelReplyTestInclude,
  infraTestOwner,
  runtimeConfigTestOwner,
  tuiPtyTestFiles,
} from "../../test/vitest/vitest.test-shards.mjs";
import { toolingIsolatedTestFiles } from "../../test/vitest/vitest.tooling-isolated-paths.mjs";
import {
  toolingDockerTestFiles,
  toolingTestExclude,
  toolingTestInclude,
} from "../../test/vitest/vitest.tooling-paths.mjs";
import {
  getUnitFastTestFiles,
  getUnitFastIsolatedTestFiles,
  getUnitFastTimerTestFiles,
} from "../../test/vitest/vitest.unit-fast-paths.mjs";
import {
  boundaryTestFiles,
  bundledPluginDependentUnitTestFiles,
  filterUnitConfigTestFiles,
} from "../../test/vitest/vitest.unit-paths.mjs";
import { getCommandFilesByOwner } from "./ci-command-test-plan.mts";
import { isStripeEligibleTestFile, listTrackedTestFiles } from "./list-test-files.mts";

export const COMPACT_EMBEDDED_BASE_GROUP_NAME = "agentic-agents-embedded-base";

export type NodeTestVolume = {
  version: 1;
  revision: string;
  policy: "node" | "bun-all" | "dual-all";
  entries: {
    config: string;
    runtime: "node" | "bun";
    engine: "vitest" | "bun-test";
    profile: string;
    environment: string;
    argsDigest: string;
    full: { id: string; count: number; digest: string } | null;
    selected: { count: number; digest: string } | null;
  }[];
};

export type NodeTestTargetVolume = {
  target: string;
  configs: string[];
  volume: NodeTestVolume;
};

export function summarizeNodeTestFiles(files: readonly string[]) {
  const unique = [...new Set(files)].toSorted();
  return {
    count: unique.length,
    digest: createHash("sha256").update(JSON.stringify(unique)).digest("hex"),
  };
}

export function listScopedOwnerTestFiles(owner: {
  root: string;
  include: string[];
  exclude: string[];
}): string[] {
  // Scoped configs drop unit-fast files, so a lister that keeps them prices
  // stripes on files the shard never runs and hands Vitest inert patterns.
  const unitFastFiles = new Set(getUnitFastTestFiles());
  const files = listTrackedTestFiles(owner.root).filter((file) =>
    isStripeEligibleTestFile(file, unitFastFiles),
  );
  const literalFiles = new Set(files.filter(isPlainRepoRelativePath));
  const literalPatterns = new Set(
    [...owner.include, ...owner.exclude].filter(isPlainRepoRelativePath),
  );
  return filterFilesByPatterns(files, owner.include, owner.exclude, (file, pattern) =>
    literalFiles.has(file) && literalPatterns.has(pattern)
      ? file === pattern
      : matchesGlob(file, pattern),
  );
}

const runtimeSharedProjectOwners = [
  {
    config: "test/vitest/vitest.acp.config.ts",
    root: "src/acp",
    include: ["src/acp/**/*.test.ts"],
    exclude: databaseWorkerCoreTestFiles,
  },
  {
    config: "test/vitest/vitest.shared-core.config.ts",
    root: "src/shared",
    include: ["src/shared/**/*.test.ts"],
    exclude: [],
  },
  {
    config: "test/vitest/vitest.utils.config.ts",
    root: "src/utils",
    include: ["src/utils/**/*.test.ts"],
    exclude: [],
  },
];

const CONFIG_FILE_OWNERS = new Map<string, Parameters<typeof listScopedOwnerTestFiles>[0]>([
  ...[...runtimeSharedProjectOwners, ...embeddedAgentVitestProjectOwners].map(
    (owner) => [owner.config, owner] as const,
  ),
  [
    "test/vitest/vitest.tui.config.ts",
    {
      root: "src/tui",
      include: ["src/tui/**/*.test.ts"],
      exclude: databaseWorkerCoreTestFiles,
    },
  ],
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
  ["test/vitest/vitest.markdown.config.ts", markdownTestFiles],
  ["test/vitest/vitest.boundary.config.ts", boundaryTestFiles],
  ["test/vitest/vitest.tui-pty.config.ts", tuiPtyTestFiles],
  ["test/vitest/vitest.gateway-server-isolated.config.ts", gatewayServerIsolatedTestFiles],
  ["test/vitest/vitest.gateway-database-workers.config.ts", gatewayDatabaseWorkerTestFiles],
]);
const configFileCache = new Map<string, string[]>();

/** Disjoint project inventories retain exact ownership within shared process groups. */
export function listNodeTestConfigFiles(config: string): string[] | undefined {
  if (config === "test/vitest/vitest.commands.config.ts") {
    return [...getCommandFilesByOwner().values()].flat().toSorted();
  }
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

/** Measurement-only ownership; adding it must not change runtime partitioning. */
export function listNodeTestVolumeConfigFiles(config: string): string[] | undefined {
  if (config === "test/vitest/vitest.unit-fast.config.ts") {
    const excluded = new Set([...getUnitFastTimerTestFiles(), ...getUnitFastIsolatedTestFiles()]);
    return getUnitFastTestFiles().filter(
      (file) => !excluded.has(file) && !isSharedVitestExcludedPath(file),
    );
  }
  if (config === "test/vitest/vitest.unit-fast-fake-timers.config.ts") {
    return getUnitFastTimerTestFiles().filter((file) => !isSharedVitestExcludedPath(file));
  }
  if (config === "test/vitest/vitest.unit-fast-isolated.config.ts") {
    return getUnitFastIsolatedTestFiles().filter((file) => !isSharedVitestExcludedPath(file));
  }
  const scopedOwner =
    config === "test/vitest/vitest.infra.config.ts"
      ? infraTestOwner
      : [agentVitestProjectOwners.core, agentVitestProjectOwners.support].find(
          (owner) => owner.config === config,
        );
  if (scopedOwner) {
    return listScopedOwnerTestFiles(scopedOwner).filter(
      (file) => !isSharedVitestExcludedPath(file, scopedOwner.root === "." ? "" : scopedOwner.root),
    );
  }
  if (config === "test/vitest/vitest.runtime-config.config.ts") {
    return listScopedOwnerTestFiles(runtimeConfigTestOwner).filter(
      (file) => !isSharedVitestExcludedPath(file, "src"),
    );
  }
  if (config === "test/vitest/vitest.tooling.config.ts") {
    return listScopedOwnerTestFiles({
      root: ".",
      include: toolingTestInclude,
      exclude: toolingTestExclude,
    }).filter((file) => !isSharedVitestExcludedPath(file));
  }
  const isolated = config === "test/vitest/vitest.tooling-isolated.config.ts";
  if (isolated || config === "test/vitest/vitest.tooling-docker.config.ts") {
    const declared = new Set(isolated ? toolingIsolatedTestFiles : toolingDockerTestFiles);
    const unitFast = isolated ? new Set<string>() : new Set(getUnitFastTestFiles());
    return listTrackedTestFiles(".").filter(
      (file) => declared.has(file) && !unitFast.has(file) && !isSharedVitestExcludedPath(file),
    );
  }
  return listNodeTestConfigFiles(config);
}

// Filtering coverage does not make a whole-config owner safe to split.
const WHOLE_CONFIG_FILE_OWNERS = new Map<
  string,
  { listFiles: () => string[]; splitByFile?: false }
>([
  ["core-markdown", { listFiles: () => markdownTestFiles }],
  [
    "agentic-agents-tools",
    {
      listFiles: () => listScopedOwnerTestFiles(agentVitestProjectOwners.tools),
      splitByFile: false,
    },
  ],
  [
    "auto-reply-core-top-level",
    {
      listFiles: () => [
        ...listNodeTestConfigFiles("test/vitest/vitest.auto-reply-core.config.ts")!,
        ...listNodeTestConfigFiles("test/vitest/vitest.auto-reply-top-level.config.ts")!,
      ],
      splitByFile: false,
    },
  ],
  [
    "agentic-command-support",
    {
      listFiles: () => [
        ...listScopedOwnerTestFiles({
          root: "src/commands",
          include: commandsLightTestFiles,
          exclude: databaseWorkerCoreTestFiles,
        }),
        ...listScopedOwnerTestFiles({
          root: "src",
          include: ["src/daemon/**/*.test.ts"],
          exclude: [],
        }),
      ],
      splitByFile: false,
    },
  ],
  [
    "core-runtime-hooks",
    {
      listFiles: () =>
        listScopedOwnerTestFiles({
          root: "src/hooks",
          include: ["src/hooks/**/*.test.ts"],
          exclude: databaseWorkerCoreTestFiles,
        }),
      splitByFile: false,
    },
  ],
  [
    "core-runtime-shared",
    {
      listFiles: () => runtimeSharedProjectOwners.flatMap(listScopedOwnerTestFiles),
      splitByFile: false,
    },
  ],
  [
    "agentic-agents-embedded",
    {
      listFiles: () => embeddedAgentVitestProjectOwners.flatMap(listScopedOwnerTestFiles),
      splitByFile: false,
    },
  ],
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
        ...gatewayPluginTestFiles.filter((file) => !gatewayMethodsTestExclude.includes(file)),
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

/** Git is authoritative: generated fixtures and non-Vitest suffixes still need an owner. */
export function scheduledTrackedTestFiles(): string[] {
  // Sparse preflight harnesses import this inventory without the source helpers.
  // Coverage itself runs in a complete checkout; retain the existing Git owner.
  const { listGitTrackedFiles }: typeof import("../../src/test-utils/repo-files.ts") =
    createRequire(import.meta.url)("../../src/test-utils/repo-files.ts");
  const files = listGitTrackedFiles({ pathspecs: "." });
  if (!files) {
    throw new Error("Scheduled test coverage requires git ls-files");
  }
  return files.filter((file) => /\.test\.(?:tsx?|mts|mjs|cjs|py)$/u.test(file));
}

export const SCHEDULED_COVERAGE_EXCEPTIONS: Array<{
  pattern: string;
  owner: string;
  reason: string;
}> = [
  {
    pattern: ".github/codeql/**/client-*.test.*",
    owner: "@openclaw/openclaw-secops",
    reason: "CodeQL query fixture inputs, not executable test suites.",
  },
  {
    pattern: "test/fixtures/**/*.test.ts",
    owner: "Developer tooling fixture owners",
    reason:
      "Source inputs for tooling regression suites; shared Vitest configuration deliberately excludes fixtures.",
  },
  {
    pattern: ".agents/skills/update-team-server/controller/*.test.*",
    owner: "Team server deployment controller",
    reason:
      "Standalone Node/Python controller self-tests use the operator skill's runner, not Vitest; no scheduled controller runner exists.",
  },
  {
    pattern: ".agents/skills/plugin-sdk-impact/scripts/*.test.mjs",
    owner: "Plugin SDK impact tooling",
    reason:
      "Standalone node:test skill self-tests have no scheduled runner and are not Vitest suites.",
  },
  {
    pattern: "crates/openclaw-iroh-node/test/*.test.cjs",
    owner: ".github/workflows/iroh-node.yml",
    reason:
      "Native binding node:test suites require the crate build; their owning workflow is path-triggered, not scheduled.",
  },
  {
    pattern: "test/scripts/pr-darwin-process-identity.test.py",
    owner: ".github/workflows/pr-tooling-darwin.yml",
    reason:
      "Darwin-only Python process identity proof runs in its path-triggered platform workflow, not the Linux Vitest runner.",
  },
  {
    pattern: "packages/ai/**/*.live.test.ts",
    owner: "AI provider live tests",
    reason:
      "Credentialed package live suites are outside test-live-shard discovery (src, test, extensions); the secretless every-file runner cannot supply provider credentials.",
  },
  {
    pattern: "src/gateway/gateway-thinking-probe.live.test.ts",
    owner: "Gateway live probe",
    reason:
      "test-live-shard explicitly excludes this operator-selected catalog probe, which refuses CI.",
  },
  {
    pattern: "test/e2e/qa-lab/plugins/slack-crabline-roundtrip.candidate.e2e.test.mts",
    owner: "QA Lab candidate proof",
    reason:
      "Requires operator-provided CRABLINE_CANDIDATE_ROOT, archive hashes and a private evidence directory for the candidate package, not the repository checkout.",
  },
];
