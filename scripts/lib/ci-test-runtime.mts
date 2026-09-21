import { matchesVitestGlob } from "../../test/vitest/vitest.pattern-file.ts";
import {
  getUnitFastIsolatedTestFiles,
  getUnitFastTestFiles,
  getUnitFastTimerTestFiles,
} from "../../test/vitest/vitest.unit-fast-paths.mjs";
import { buildVitestRunPlans } from "../test-projects.test-support.mts";

export type CiTestRuntimePolicy = "node" | "bun-compatible" | "dual";
type TestRuntime = "node" | "bun";
type TestSelection = {
  configs?: readonly string[];
  targets?: readonly string[];
  includePatterns?: readonly string[] | null;
  env?: Record<string, unknown> | null;
  vitestArgs?: readonly string[];
};
type TestShard = TestSelection & { groups?: readonly TestSelection[] };
export type CiTestRuntimeSelection = { runtime: TestRuntime; includePatterns?: string[] };

const bunCompatibleConfigs = new Set(["test/vitest/vitest.unit-fast-fake-timers.config.ts"]);
// Bun fork 3ff0efc82217775e04094a1d4402d7c6932ecb24 failed or added skips in these files.
// Keep every case on Node while the canonical inventories own all other membership.
const runtimePartitions = new Map<
  string,
  { files: () => string[]; nodeRequired: ReadonlySet<string> }
>([
  [
    "test/vitest/vitest.unit-fast.config.ts",
    {
      files: unitFastFiles,
      nodeRequired: new Set([
        "packages/markdown-core/src/render-aware-chunking.test.ts",
        "src/agents/sandbox/docker.execDockerRaw.enoent.test.ts",
        "src/cli/cli-process-diagnostics.test.ts",
        "src/process/spawn-broker/callback-context.test.ts",
        "src/process/spawn-broker/cleanup.test.ts",
        "src/process/spawn-broker/handoff.test.ts",
        "src/process/spawn-broker/proxy-retention.test.ts",
        "src/process/spawn-broker/relay.test.ts",
        "src/process/spawn-broker/startup.test.ts",
        "src/process/spawn-broker/stdin-handoff.test.ts",
        "src/process/spawn-broker/transports.test.ts",
        "test/scripts/update-restart-module-outcome.test.ts",
      ]),
    },
  ],
  [
    "test/vitest/vitest.unit-fast-isolated.config.ts",
    {
      files: getUnitFastIsolatedTestFiles,
      nodeRequired: new Set(["src/proxy-capture/proxy-server.test.ts"]),
    },
  ],
]);

function unitFastFiles(): string[] {
  const otherOwners = new Set([...getUnitFastTimerTestFiles(), ...getUnitFastIsolatedTestFiles()]);
  return getUnitFastTestFiles().filter((file) => !otherOwners.has(file));
}

function selectionVitestArgs(selection: TestSelection): string[] | undefined {
  let args: unknown = selection.vitestArgs;
  if (!args) {
    try {
      const encoded = selection.env?.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON;
      args = typeof encoded === "string" && encoded.trim() ? JSON.parse(encoded) : [];
    } catch {
      return undefined;
    }
  }
  return Array.isArray(args) && args.every((arg) => typeof arg === "string") ? args : undefined;
}

function supportsRuntimePartition(args: string[]): boolean {
  // Native sharding, alternate roots/projects, filters and config overrides can
  // change membership. Admit only resource/deadline flags with known semantics.
  return args.every((arg) => /^--(?:maxWorkers|testTimeout|hookTimeout)=\d+$/u.test(arg));
}

export function resolveCiTestRuntimePolicy(
  env: NodeJS.ProcessEnv = process.env,
): CiTestRuntimePolicy {
  const policy = env.OPENCLAW_CI_TEST_RUNTIME_POLICY?.trim() || "node";
  if (policy !== "node" && policy !== "bun-compatible" && policy !== "dual") {
    throw new Error(
      `Invalid OPENCLAW_CI_TEST_RUNTIME_POLICY: ${policy}; expected node, bun-compatible, or dual`,
    );
  }
  return policy;
}

export function resolveCiTestRuntimeSelections(
  selection: TestSelection,
  policy: CiTestRuntimePolicy,
  cwd = process.cwd(),
): CiTestRuntimeSelection[] {
  const node: CiTestRuntimeSelection[] = [{ runtime: "node" }];
  const args = selectionVitestArgs(selection);
  if (
    policy === "node" ||
    selection.env?.OPENCLAW_VITEST_INCLUDE_FILE ||
    !args ||
    !supportsRuntimePartition(args)
  ) {
    return node;
  }
  const completeBun = (): CiTestRuntimeSelection[] =>
    policy === "dual" ? [{ runtime: "node" }, { runtime: "bun" }] : [{ runtime: "bun" }];
  if (selection.targets?.length) {
    // Preserve exact target argv and its native owner; broad targets can carry
    // multiple process/filter contracts and stay on Node.
    if (selection.targets.some((target) => !/^[\w./-]+\.test\.[cm]?[jt]sx?$/u.test(target))) {
      return node;
    }
    const plans = selection.targets.flatMap((target) => buildVitestRunPlans([target], cwd));
    if (!plans.length) {
      return node;
    }
    if (plans.every((plan) => bunCompatibleConfigs.has(plan.config))) {
      return completeBun();
    }
    const config = plans[0]!.config;
    const partition = runtimePartitions.get(config);
    if (!partition || !plans.every((plan) => plan.config === config)) {
      return node;
    }
    const files = new Set(partition.files());
    return selection.targets.every(
      (target) => files.has(target) && !partition.nodeRequired.has(target),
    )
      ? completeBun()
      : node;
  }
  if (selection.configs?.length !== 1) {
    return node;
  }
  const config = selection.configs[0]!;
  if (bunCompatibleConfigs.has(config)) {
    return completeBun();
  }
  const partition = runtimePartitions.get(config);
  if (!partition) {
    return node;
  }
  const files = partition
    .files()
    .filter(
      (file) =>
        !selection.includePatterns ||
        selection.includePatterns.some((pattern) => matchesVitestGlob(file, pattern)),
    );
  const bunFiles = files.filter((file) => !partition.nodeRequired.has(file));
  if (!bunFiles.length) {
    return node;
  }
  const nodeFiles = files.filter((file) => partition.nodeRequired.has(file));
  return [
    ...(policy === "dual"
      ? node
      : nodeFiles.length
        ? [{ runtime: "node" as const, includePatterns: nodeFiles }]
        : []),
    { runtime: "bun", includePatterns: bunFiles },
  ];
}

/** Match the shard runner's original process envelopes without splitting or dropping coverage. */
export function ciTestShardRequiresBun(
  shard: TestShard,
  policy: CiTestRuntimePolicy,
  cwd = process.cwd(),
): boolean {
  const selections = shard.targets?.length
    ? shard.targets.map((target) => ({ ...shard, targets: [target] }))
    : shard.groups?.length
      ? shard.groups.map((group) => ({ ...group, env: { ...shard.env, ...group.env } }))
      : [shard];
  return selections.some((selection) =>
    resolveCiTestRuntimeSelections(selection, policy, cwd).some(({ runtime }) => runtime === "bun"),
  );
}
