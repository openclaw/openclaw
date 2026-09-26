/**
 * Advisory shard size. Oversized shards only warn: they cost tsgo memory and wall
 * time but never block CI, so unrelated test-only PRs keep landing while a
 * rebalance is scheduled.
 */
const TSGO_CORE_TEST_MAX_ROOTS = 720;

export const TSGO_CORE_TEST_SHARDS = [
  {
    name: "agents-root",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.agents-root.json",
  },
  {
    name: "agents-other",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.agents-other.json",
  },
  {
    name: "agents-tools",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.agents-tools.json",
  },
  {
    name: "gateway-root",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.gateway-root.json",
  },
  {
    name: "gateway-server",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.gateway-server.json",
  },
  {
    name: "gateway-other",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.gateway-other.json",
  },
  { name: "infra", group: "src", config: "test/tsconfig/tsconfig.core.test.infra.json" },
  {
    name: "state-logging",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.state-logging.json",
  },
  { name: "commands", group: "src", config: "test/tsconfig/tsconfig.core.test.commands.json" },
  {
    name: "plugins-platform",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.plugins-platform.json",
  },
  {
    name: "config-cli",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.config-cli.json",
  },
  { name: "messaging", group: "src", config: "test/tsconfig/tsconfig.core.test.messaging.json" },
  { name: "services", group: "src", config: "test/tsconfig/tsconfig.core.test.services.json" },
  { name: "other", group: "src", config: "test/tsconfig/tsconfig.core.test.other.json" },
  {
    name: "ui-pages",
    group: "ui",
    config: "test/tsconfig/tsconfig.core.test.ui-pages.json",
  },
  {
    name: "ui-e2e",
    group: "ui",
    config: "test/tsconfig/tsconfig.core.test.ui-e2e.json",
  },
  { name: "ui-other", group: "ui", config: "test/tsconfig/tsconfig.core.test.ui-other.json" },
  {
    name: "packages",
    group: "packages",
    config: "test/tsconfig/tsconfig.test.packages.json",
    sparseRoots: ["packages", "src", "ui/src"],
  },
  {
    name: "plugin-sdk",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.plugin-sdk.json",
  },
  // Append new splits to preserve the existing CI stripe assignments.
  {
    name: "commands-doctor",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.commands-doctor.json",
  },
  {
    name: "cli-update",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.cli-update.json",
  },
  {
    name: "gateway-methods",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.gateway-methods.json",
  },
  {
    name: "ui-chat",
    group: "ui",
    config: "test/tsconfig/tsconfig.core.test.ui-chat.json",
  },
  {
    name: "agents-sessions",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.agents-sessions.json",
  },
  {
    name: "services-cron",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.services-cron.json",
  },
  {
    name: "agents-prepared-runtime",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.agents-prepared-runtime.json",
  },
] as const;

export const TSGO_CORE_GRAPHS = [
  { name: "core", config: "tsconfig.core.json" },
  { name: "ui", config: "tsconfig.ui.json" },
  ...TSGO_CORE_TEST_SHARDS.map((shard) => ({
    name: `core-test-${shard.name}`,
    config: shard.config,
  })),
];

export const TSGO_CI_ADDITIONAL_GRAPHS = [
  { name: "extensions", config: "tsconfig.extensions.json" },
  { name: "extensions-test", config: "test/tsconfig/tsconfig.extensions.test.json" },
  { name: "scripts", config: "tsconfig.scripts.json" },
  { name: "test-root", config: "test/tsconfig/tsconfig.test.root.json" },
] as const;

export const TSGO_CI_GRAPHS = [...TSGO_CORE_GRAPHS, ...TSGO_CI_ADDITIONAL_GRAPHS];

/** Manifest rows may request canonical graphs, never arbitrary compiler arguments. */
export function resolveCiTsgoGraphs(names: readonly string[]) {
  if (names.length === 0) {
    throw new Error("CI type graph names must be nonempty, unique, and canonical");
  }
  const selected = new Set<string>();
  return names.map((name) => {
    const graph = TSGO_CI_GRAPHS.find((candidate) => candidate.name === name);
    if (!graph || selected.has(name)) {
      throw new Error("CI type graph names must be nonempty, unique, and canonical");
    }
    selected.add(name);
    return graph;
  });
}

/** Configuration, ambient declarations and unclassified inputs retain every graph. */
function isChangedCiTsgoInput(file: string): boolean {
  return (
    /^(?:src|ui|packages|extensions|scripts|test)\/.+\.[cm]?[jt]sx?$/u.test(file) &&
    !/\.d\.[cm]?ts$/u.test(file)
  );
}

/** Compiler inventories include erased type imports and cross-family consumers. */
export function selectChangedCiTsgoGraphs(
  paths: readonly string[],
  graphs: readonly { config: string; files: readonly string[] }[],
): readonly { name: string; config: string }[] | undefined {
  // Documentation and UI styles cannot change compiler inputs. Keep data and
  // configuration paths for the conservative admission below.
  const compilerPaths = paths.filter(
    (file) => !/\.mdx?$/u.test(file) && !/^ui\/.+\.css$/u.test(file),
  );
  if (
    compilerPaths.length === 0 ||
    !compilerPaths.every(isChangedCiTsgoInput) ||
    graphs.length !== TSGO_CI_GRAPHS.length ||
    TSGO_CI_GRAPHS.some(
      (expected) => graphs.filter((graph) => graph.config === expected.config).length !== 1,
    ) ||
    compilerPaths.some((file) => !graphs.some((graph) => graph.files.includes(file)))
  ) {
    return undefined;
  }
  return TSGO_CI_GRAPHS.filter((expected) =>
    graphs.some(
      (graph) =>
        graph.config === expected.config &&
        compilerPaths.some((file) => graph.files.includes(file)),
    ),
  );
}

export type TsgoCoreTestShard = (typeof TSGO_CORE_TEST_SHARDS)[number];

export const TSGO_TARGETED_TEST_SHARED_SHARDS = [
  {
    name: "extension-declarations",
    config: "test/tsconfig/tsconfig.test.extension-declarations.json",
    sparseRoots: ["extensions", "src", "ui/src"],
  },
] as const;

export function selectTsgoCoreTestShards(
  requestedGroup?: string,
): readonly { name: string; config: string }[] | undefined {
  if (!requestedGroup) {
    return TSGO_CORE_TEST_SHARDS;
  }
  const selected = TSGO_CORE_TEST_SHARDS.filter((shard) => shard.group === requestedGroup);
  if (selected.length === 0) {
    return undefined;
  }
  // Targeted aliases historically checked extension declarations as shared ambient input.
  return [...selected, ...TSGO_TARGETED_TEST_SHARED_SHARDS];
}

/**
 * Deterministic round-robin stripe over the full shard list for CI-level
 * parallelism. Shard walls are near-uniform, so index striping stays balanced
 * as shards are added; the union across stripes is exactly the full list.
 */
export function selectTsgoCoreTestStripe(
  stripeSpec: string,
): readonly { name: string; config: string }[] | undefined {
  const match = /^([1-9]\d*)(?:-([1-9]\d*))?\/([1-9]\d*)$/u.exec(stripeSpec);
  if (!match) {
    return undefined;
  }
  const stripe = Number(match[1]);
  const lastStripe = Number(match[2] ?? match[1]);
  const stripeCount = Number(match[3]);
  if (
    ![stripe, lastStripe, stripeCount].every(Number.isSafeInteger) ||
    stripe > lastStripe ||
    lastStripe > stripeCount
  ) {
    return undefined;
  }
  return TSGO_CORE_TEST_SHARDS.filter((_, index) => {
    const owner = (index % stripeCount) + 1;
    return owner >= stripe && owner <= lastStripe;
  });
}

/** Oversized shards are advisory: report them as warnings, never as violations. */
export function findOversizedTsgoCoreTestShards(params: {
  maxRoots?: number;
  shards: readonly { name: string; roots: readonly string[] }[];
}): string[] {
  const maxRoots = params.maxRoots ?? TSGO_CORE_TEST_MAX_ROOTS;
  return params.shards
    .filter((shard) => shard.roots.length > maxRoots)
    .map(
      (shard) =>
        `${shard.name}: ${shard.roots.length} test roots exceeds the advisory ${maxRoots} limit; rebalance when convenient`,
    );
}

export function findTsgoCoreTestShardViolations(params: {
  canonicalRoots: readonly string[];
  shards: readonly { name: string; roots: readonly string[] }[];
}): string[] {
  const canonical = new Set(params.canonicalRoots);
  const owners = new Map<string, string[]>();
  const violations: string[] = [];

  for (const shard of params.shards) {
    for (const root of shard.roots) {
      const rootOwners = owners.get(root) ?? [];
      rootOwners.push(shard.name);
      owners.set(root, rootOwners);
    }
  }

  for (const root of canonical) {
    const rootOwners = owners.get(root) ?? [];
    if (rootOwners.length === 0) {
      violations.push(`unassigned: ${root}`);
    } else if (rootOwners.length > 1) {
      violations.push(`assigned ${rootOwners.length} times (${rootOwners.join(", ")}): ${root}`);
    }
  }
  for (const [root, rootOwners] of owners) {
    if (!canonical.has(root)) {
      violations.push(`not in the canonical core-test graph (${rootOwners.join(", ")}): ${root}`);
    }
  }

  return violations;
}

/** Ambient declarations and compiler configuration retain the full graph check. */
export function isChangedTsgoCoreTestInput(file: string): boolean {
  return (
    /^(?:src|ui|packages|test)\/.+\.[cm]?[jt]sx?$/u.test(file) &&
    !/\.d\.[cm]?ts$/u.test(file) &&
    !/^test\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
  );
}

/** Select every consuming graph, not just the file's declared root partition. */
export function selectChangedTsgoCoreTestShards(
  paths: readonly string[],
  graphs: readonly { config: string; roots: readonly string[]; files: readonly string[] }[],
): readonly { name: string; config: string }[] | undefined {
  if (paths.length === 0 || !paths.every(isChangedTsgoCoreTestInput)) {
    return undefined;
  }
  const changedTestRoots = paths.filter((file) =>
    /^(?:src|ui|packages)\/.+\.test\.tsx?$/u.test(file),
  );
  const testConfigs = new Set<string>(TSGO_CORE_TEST_SHARDS.map((shard) => shard.config));
  const testGraphs = graphs.filter((graph) => testConfigs.has(graph.config));
  if (
    graphs.length !== TSGO_CORE_GRAPHS.length ||
    TSGO_CORE_GRAPHS.some(
      (expected) => graphs.filter((graph) => graph.config === expected.config).length !== 1,
    ) ||
    changedTestRoots.some(
      (file) => testGraphs.filter((graph) => graph.roots.includes(file)).length !== 1,
    ) ||
    paths.some((file) => !testGraphs.some((graph) => graph.files.includes(file))) ||
    graphs.some(
      (graph) =>
        !testConfigs.has(graph.config) &&
        changedTestRoots.some((file) => graph.files.includes(file)),
    )
  ) {
    return undefined;
  }
  return TSGO_CORE_TEST_SHARDS.filter((shard) =>
    testGraphs.some(
      (graph) => graph.config === shard.config && paths.some((file) => graph.files.includes(file)),
    ),
  );
}
