import { globSync } from "node:fs";
import { agentVitestProjectOwners } from "../../test/vitest/vitest.agents-paths.mjs";
import {
  matchesVitestCliSelection,
  matchesVitestGlob,
  relativizeScopedPatterns,
} from "../../test/vitest/vitest.pattern-file.ts";
import { controlUiE2eTestGlobs, controlUiTestGlobs } from "../../test/vitest/vitest.ui-paths.mjs";
import {
  getUnitFastIsolatedTestFiles,
  getUnitFastTestFiles,
  getUnitFastTimerTestFiles,
} from "../../test/vitest/vitest.unit-fast-paths.mjs";
import { buildVitestRunPlans } from "../test-projects.test-support.mts";
import { vitestOptionConsumesNextArg } from "./vitest-cli-mode.mts";

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
export type CiTestRuntimeSelection = {
  runtime: TestRuntime;
  configs?: string[];
  includePatterns?: string[];
  includeAfterShard?: true;
  env?: Readonly<Record<string, string>>;
};

// Short-lived UI workers spend less time compiling their top JIT tier when it
// starts later. Keep every tier enabled and share the producer/consumer policy.
export const BUN_UI_TEST_ENV = {
  BUN_JSC_thresholdForFTLOptimizeAfterWarmUp: "512000",
  BUN_JSC_thresholdForFTLOptimizeSoon: "8000",
  // Avoid sweeping parked allocator threads between short UI update cycles.
  MIMALLOC_PURGE_HOLES_MIN_INTERVAL: "1000",
} as const;

const gatewayCoreConfig = "test/vitest/vitest.gateway-core.config.ts";
const gatewayClientConfig = "test/vitest/vitest.gateway-client.config.ts";
const bunCompatibleConfigs = new Set([
  "test/vitest/vitest.unit-fast-fake-timers.config.ts",
  gatewayClientConfig,
]);
// Measured whole-file admission; the rest of agents-support retains Node.
const bunCompatibleAgentSupportFiles = ["src/agents/worktrees/service.removal-recovery.test.ts"];
// TypeScript's synchronous native API uses Node child-process pipe handles.
// Keep these compiler assertions on Node, including those in mixed runtime suites.
const nativeCompilerTestFiles = [
  "src/agents/agent-bundle-mcp-requester-connect.import-boundary.test.ts",
  "src/agents/agent-model-discovery.imports.test.ts",
  "src/agents/code-mode.action-output.test.ts",
  "src/agents/harness/native-hook-relay.imports.test.ts",
  "src/cli/program/register.database.import-boundary.test.ts",
  "src/plugin-sdk/provider-tools.test.ts",
  "test/scripts/audit-control-ui-dead-css.test.ts",
  "test/scripts/canvas-cli-import-closure.test.ts",
  "test/scripts/check-session-accessor-boundary.test.ts",
  "test/scripts/check-session-transcript-reader-boundary.test.ts",
  "test/scripts/check-sqlite-transaction-boundary.test.ts",
  "test/scripts/native-typescript.test.ts",
  "test/scripts/nodes-cli-import-closure.test.ts",
  "test/scripts/ts-topology.test.ts",
  "test/test-helper-extension-import-boundary.test.ts",
];
// Bun fork 3ff0efc82217775e04094a1d4402d7c6932ecb24 failed or added skips in these files.
// Keep every case on Node while the canonical inventories own all other membership.
const runtimePartitions = new Map<
  string,
  { files: (cwd: string) => string[]; nodeRequired: ReadonlySet<string>; includeAfterShard?: true }
>([
  [
    "test/vitest/vitest.unit-fast.config.ts",
    {
      files: unitFastFiles,
      nodeRequired: new Set([
        ...nativeCompilerTestFiles,
        "packages/markdown-core/src/render-aware-chunking.test.ts",
        // Bun skips a sibling diagnostics subscriber when warm-worker cleanup unsubscribes.
        "src/agents/code-mode-node.test.ts",
        "src/cli/cli-process-diagnostics.test.ts",
        // Native heap accounting, GC, and Worker limits require V8.
        "src/infra/worker-task-pool.memory.test.ts",
        "src/process/spawn-broker/callback-context.test.ts",
        "src/process/spawn-broker/cleanup.test.ts",
        "src/process/spawn-broker/handoff.test.ts",
        "src/process/spawn-broker/proxy-retention.test.ts",
        "src/process/spawn-broker/relay.test.ts",
        "src/process/spawn-broker/startup.test.ts",
        "src/process/spawn-broker/stdin-handoff.test.ts",
        "src/process/spawn-broker/transports.test.ts",
        // Preserve native Node process and SQLite lifecycle semantics for this benchmark.
        "test/scripts/bench-session-history.test.ts",
        "test/scripts/update-restart-module-outcome.test.ts",
      ]),
    },
  ],
  [
    "test/vitest/vitest.unit-fast-isolated.config.ts",
    {
      files: () => getUnitFastIsolatedTestFiles(),
      nodeRequired: new Set([...nativeCompilerTestFiles, "src/proxy-capture/proxy-server.test.ts"]),
    },
  ],
  [
    "ui/vitest.config.ts",
    {
      files: (cwd) =>
        globSync(controlUiTestGlobs, { cwd, exclude: controlUiE2eTestGlobs })
          .map((file) => file.replaceAll("\\", "/"))
          .toSorted(),
      // Bun GC can retain released chat and overview payloads; keep their retention proof on Node.
      nodeRequired: new Set([
        "ui/src/pages/chat/chat-thread.test.ts",
        "ui/src/pages/usage/usage-page-details.test.ts",
      ]),
      includeAfterShard: true,
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
  // change membership. Collection skips every body but preserves file imports.
  return args.every(
    (arg) =>
      arg === "--testNamePattern=(?!)" ||
      /^--(?:maxWorkers|testTimeout|hookTimeout)=\d+$/u.test(arg),
  );
}

function supportsUiRuntime(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const consumesNext = vitestOptionConsumesNextArg(arg, args[index + 1]);
    const separator = arg.indexOf("=");
    const option = separator < 0 ? arg : arg.slice(0, separator);
    const value = consumesNext
      ? args[++index]
      : separator < 0
        ? undefined
        : arg.slice(separator + 1);
    if (/^--(?:maxWorkers|testTimeout|hookTimeout)$/u.test(option) && /^\d+$/u.test(value ?? "")) {
      continue;
    }
    if (option === "--shard" && /^[1-9]\d*\/[1-9]\d*$/u.test(value ?? "")) {
      const [shard, count] = value!.split("/").map(Number);
      if (shard! <= count!) {
        continue;
      }
    }
    if (
      option === "--reporter" &&
      ["verbose", "github-actions", "./scripts/lib/vitest-resource-reporter.mts"].includes(
        value ?? "",
      )
    ) {
      continue;
    }
    return false;
  }
  return true;
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
    selection.env?.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE ||
    !args
  ) {
    return node;
  }
  const completeBun = (): CiTestRuntimeSelection[] =>
    policy === "dual" ? [{ runtime: "node" }, { runtime: "bun" }] : [{ runtime: "bun" }];
  const uiPartition =
    selection.configs?.length === 1 &&
    selection.configs[0] === "ui/vitest.config.ts" &&
    !selection.targets?.length &&
    supportsUiRuntime(args);
  if (!uiPartition && !supportsRuntimePartition(args)) {
    return node;
  }
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
    if (
      plans.every((plan) => plan.config === agentVitestProjectOwners.support.config) &&
      selection.targets.every((file) => bunCompatibleAgentSupportFiles.includes(file))
    ) {
      return completeBun();
    }
    const config = plans[0]!.config;
    const partition = runtimePartitions.get(config);
    if (
      !partition ||
      partition.includeAfterShard ||
      !plans.every((plan) => plan.config === config)
    ) {
      return node;
    }
    const files = new Set(partition.files(cwd));
    return selection.targets.every(
      (target) => files.has(target) && !partition.nodeRequired.has(target),
    )
      ? completeBun()
      : node;
  }
  if (
    selection.configs?.length === 2 &&
    selection.configs[0] === gatewayCoreConfig &&
    selection.configs[1] === gatewayClientConfig
  ) {
    const parallelProjects = selection.env?.OPENCLAW_TEST_PROJECTS_PARALLEL;
    if (typeof parallelProjects === "string" && parallelProjects.trim() !== "1") {
      return node;
    }
    // These leaf configs already run sequentially and intersect the shared
    // include envelope with their own inventories. Keep that ownership intact.
    return [
      ...(policy === "dual" ? node : [{ runtime: "node" as const, configs: [gatewayCoreConfig] }]),
      { runtime: "bun", configs: [gatewayClientConfig] },
    ];
  }
  if (selection.configs?.length !== 1) {
    return node;
  }
  const config = selection.configs[0]!;
  if (bunCompatibleConfigs.has(config)) {
    return completeBun();
  }
  if (config === agentVitestProjectOwners.support.config) {
    const owner = agentVitestProjectOwners.support;
    const includePatterns = selection.includePatterns?.length ? selection.includePatterns : null;
    const qualifiedPatterns = relativizeScopedPatterns(bunCompatibleAgentSupportFiles, owner.dir);
    if (
      includePatterns &&
      relativizeScopedPatterns(includePatterns, owner.dir).every((pattern) =>
        qualifiedPatterns.includes(pattern),
      )
    ) {
      return completeBun();
    }
    const bunFiles =
      policy === "dual"
        ? bunCompatibleAgentSupportFiles.filter((file) =>
            matchesVitestCliSelection(file, owner.include, [], owner.dir, {}, includePatterns),
          )
        : [];
    return bunFiles.length ? [...node, { runtime: "bun", includePatterns: bunFiles }] : node;
  }
  const partition = runtimePartitions.get(config);
  if (!partition || (partition.includeAfterShard && !uiPartition)) {
    return node;
  }
  const inventory = partition.files(cwd);
  const requested = new Set(selection.includePatterns ?? []);
  // Canonical file inventories should not reparse every file pair as a glob.
  const exactFiles = selection.includePatterns?.every(
    (pattern) => /^[\w./-]+$/u.test(pattern) && inventory.includes(pattern),
  );
  const files = inventory.filter(
    (file) =>
      !selection.includePatterns ||
      (exactFiles
        ? requested.has(file)
        : selection.includePatterns.some((pattern) => matchesVitestGlob(file, pattern))),
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
        ? [
            {
              runtime: "node" as const,
              includePatterns: nodeFiles,
              ...(partition.includeAfterShard ? { includeAfterShard: true as const } : {}),
            },
          ]
        : []),
    {
      runtime: "bun",
      includePatterns: bunFiles,
      ...(partition.includeAfterShard ? { includeAfterShard: true } : {}),
      ...(config === "ui/vitest.config.ts" ? { env: BUN_UI_TEST_ENV } : {}),
    },
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
      ? shard.groups.map((group) => ({
          ...group,
          env: {
            ...shard.env,
            ...group.env,
            // The runner replaces inherited project parallelism before applying group overrides.
            OPENCLAW_TEST_PROJECTS_PARALLEL:
              typeof group.env?.OPENCLAW_TEST_PROJECTS_PARALLEL === "string"
                ? group.env.OPENCLAW_TEST_PROJECTS_PARALLEL
                : "1",
          },
        }))
      : [shard];
  return selections.some((selection) =>
    resolveCiTestRuntimeSelections(selection, policy, cwd).some(({ runtime }) => runtime === "bun"),
  );
}
