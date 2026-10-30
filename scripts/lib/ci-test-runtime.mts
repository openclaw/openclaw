import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  loadPatternListFromEnv,
  matchesVitestGlob,
} from "../../test/vitest/vitest.pattern-file.ts";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";
import { controlUiE2eTestGlobs, controlUiTestGlobs } from "../../test/vitest/vitest.ui-paths.mjs";
import {
  getUnitFastIsolatedTestFiles,
  getUnitFastTestFiles,
  getUnitFastTimerTestFiles,
} from "../../test/vitest/vitest.unit-fast-paths.mjs";
import { buildVitestRunPlans } from "../test-projects.test-support.mts";
import { listNodeTestConfigFiles, listWholeConfigFiles } from "./ci-node-test-inventory.mts";
import nativeBunQualification from "./ci-test-native-bun-qualification.json" with { type: "json" };
import { vitestOptionConsumesNextArg } from "./vitest-cli-mode.mts";

export type CiTestRuntimePolicy = "node" | "bun-all" | "dual-all";
type TestRuntime = "node" | "bun";
type TestSelection = {
  configs?: readonly string[];
  targets?: readonly string[];
  includePatterns?: readonly string[] | null;
  env?: Record<string, unknown> | null;
  vitestArgs?: readonly string[];
};
type TestShard = TestSelection & { groups?: readonly TestSelection[] };
type VitestRuntimeSelection = {
  runtime: TestRuntime;
  engine?: "vitest";
  configs?: string[];
  vitestArgs?: string[];
  targets?: string[];
  includePatterns?: string[];
  includeAfterShard?: true;
  env?: Readonly<Record<string, string>>;
};
export type CiTestRuntimeSelection =
  | VitestRuntimeSelection
  | {
      runtime: "bun";
      engine: "bun-test";
      files: string[];
      configs?: never;
      targets?: never;
      vitestArgs?: never;
      includePatterns?: never;
      includeAfterShard?: never;
      env?: never;
    };

// Short-lived UI workers spend less time compiling their top JIT tier when it
// starts later. Keep every tier enabled and share the producer/consumer policy.
export const BUN_UI_TEST_ENV = {
  BUN_JSC_thresholdForFTLOptimizeAfterWarmUp: "512000",
  BUN_JSC_thresholdForFTLOptimizeSoon: "8000",
  // Each shared worker otherwise grows against the whole runner's RAM. Collect
  // after 256 MiB of allocation per cycle; this does not cap the live heap.
  BUN_JSC_gcMaxHeapSize: "268435456",
  // Avoid sweeping parked allocator threads between short UI update cycles.
  MIMALLOC_PURGE_HOLES_MIN_INTERVAL: "1000",
} as const;

const unitFastConfig = "test/vitest/vitest.unit-fast.config.ts";
const exactTestFilePattern = /^[\w./-]+\.test\.[cm]?[jt]sx?$/u;
const nativeBunTestHashes: Readonly<Record<string, string>> = nativeBunQualification.tests;
const nativeBunHelperHashes: Readonly<Record<string, Readonly<Record<string, string>>>> =
  nativeBunQualification.helpers;
// These contracts exercise Node's transferable POSIX pipe handles, including
// suites that would otherwise pass on Bun by skipping their broker assertions.
const nodeRequiredProcessFiles = new Set([
  "src/process/spawn-broker/callback-context.test.ts",
  "src/process/spawn-broker/cleanup.test.ts",
  "src/process/spawn-broker/command-startup.test.ts",
  "src/process/spawn-broker/detached-cleanup.test.ts",
  "src/process/spawn-broker/execa.test.ts",
  "src/process/spawn-broker/execution-deadline.test.ts",
  "src/process/spawn-broker/handoff-crash.test.ts",
  "src/process/spawn-broker/handoff.test.ts",
  "src/process/spawn-broker/host.test.ts",
  "src/process/spawn-broker/spawn-failure.test.ts",
  "src/process/spawn-broker/stdin-handoff.test.ts",
  "src/process/spawn-utils.test.ts",
  // Keep the Node broker/subreaper cases and two-process relay retirement proof.
  "src/process/supervisor/adapters/child.service-lifecycle.test.ts",
  "src/process/supervisor/service-child-relay-host.retirement.test.ts",
]);
// Bun policies retain Node/V8 contracts and known fork defects on Node.
const nodeRequiredFiles = new Set([
  ...nodeRequiredProcessFiles,
  // Bun reports peer ECONNRESET when destroying a socket with a pending reply; fork compat review pending.
  "src/infra/exec-host.socket.test.ts",
  // The macOS directory watch helper serves Node's libuv watchers only.
  "src/infra/directory-watch-host.test.ts",
  // Node's trace-exit, diagnostic reports, and native process/SQLite lifecycle.
  "src/cli/cli-process-diagnostics.test.ts",
  "test/scripts/bench-session-history.test.ts",
  // These proofs require V8 heap instrumentation or Node worker heap flags.
  "src/infra/worker-heap-flag.test.ts",
  "src/logging/diagnostic-heap-profile.test.ts",
  "src/gateway/server-methods/diagnostics.heap-snapshot.test.ts",
  // Consumed async-loader retention is specific to V8's suspended frames.
  "src/agents/harness/lifecycle-hook-helpers.test.ts",
  // JavaScriptCore's conservative stack scanning cannot prove forced WeakRef collection.
  "packages/ai/src/transports/openai-responses-websocket.test.ts",
  "src/agents/agent-tools.execution-validation.test.ts",
  "src/config/sessions/session-accessor.pending-input-retention.test.ts",
  "src/gateway/session-list-history-retention.test.ts",
  "src/gateway/session-row-projection.retention.test.ts",
  "src/gateway/session-database-retention.test.ts",
  "ui/src/components/desktop/desktop-mobile-keyboard.test.ts",
  "ui/src/lib/reactive/session-progress-roster.test.ts",
  "ui/src/pages/chat/chat-pane-retention.test.ts",
  "ui/src/pages/chat/chat-thread-retention.test.ts",
  "ui/src/pages/chat/components/chat-transcript-layout-retention.test.ts",
  "ui/src/pages/chat/session-message-cache-retention.test.ts",
  "ui/src/pages/chat/session-snapshot-store.test.ts",
  "ui/src/pages/usage/usage-page-retention.test.ts",
]);
// Real Code Mode workers exercise both host runtimes independently of their
// Node/QuickJS guest choice. Keep Bun coverage while qualifying Node workers.
const bothHostFiles = new Set([
  "src/agents/code-mode.bridge.lifecycle.test.ts",
  "src/agents/code-mode-engine-parity.test.ts",
  "src/agents/code-mode.failure-phase.test.ts",
]);
const knownConfigs = new Set([
  "ui/vitest.config.ts",
  ...fullSuiteVitestShards.flatMap(({ config, projects }) => [config, ...(projects ?? [])]),
]);

function unitFastFiles(includePatterns?: string[]): string[] {
  const otherOwners = new Set([
    ...getUnitFastTimerTestFiles(includePatterns),
    ...getUnitFastIsolatedTestFiles(includePatterns),
  ]);
  return getUnitFastTestFiles(includePatterns).filter((file) => !otherOwners.has(file));
}

function nativeBunSourceHash(file: string, cwd: string): string | undefined {
  try {
    return createHash("sha256")
      .update(readFileSync(path.join(cwd, file)))
      .digest("hex");
  } catch {
    // Missing or unreadable qualification inputs retain the ordinary Vitest run.
    return undefined;
  }
}

function matchesNativeBunSource(file: string, sha256: string, cwd: string): boolean {
  return nativeBunSourceHash(file, cwd) === sha256;
}

export function inspectNativeBunQualifications(cwd = process.cwd()): {
  staleEntries: string[];
  changedInputs: { file: string; reason: "changed" | "unreadable" }[];
} {
  const hashes = new Map<string, string | undefined>();
  const changedInputs = new Map<string, "changed" | "unreadable">();
  const changed = (file: string, expected: string): boolean => {
    if (!hashes.has(file)) {
      hashes.set(file, nativeBunSourceHash(file, cwd));
    }
    const actual = hashes.get(file);
    if (actual === expected) {
      return false;
    }
    changedInputs.set(file, actual === undefined ? "unreadable" : "changed");
    return true;
  };
  // Inspect every input even when shared drift already invalidates the cohort.
  const sharedChanged = Object.entries(nativeBunQualification.setup)
    .map(([file, sha256]) => changed(file, sha256))
    .some(Boolean);
  const staleEntries = Object.entries(nativeBunTestHashes)
    .filter(([file, sha256]) => {
      const testChanged = changed(file, sha256);
      const helperChanged = Object.entries(nativeBunHelperHashes[file] ?? {})
        .map(([helper, hash]) => changed(helper, hash))
        .some(Boolean);
      return sharedChanged || testChanged || helperChanged;
    })
    .map(([file]) => file)
    .toSorted();
  return {
    staleEntries,
    changedInputs: [...changedInputs.keys()]
      .toSorted()
      .map((file) => ({ file, reason: changedInputs.get(file)! })),
  };
}

function qualifiedNativeBunFiles(files: readonly string[], cwd: string): string[] {
  const candidates = files.filter((file) => nativeBunTestHashes[file]);
  if (
    !candidates.length ||
    !Object.entries(nativeBunQualification.setup).every(([file, sha256]) =>
      matchesNativeBunSource(file, sha256, cwd),
    )
  ) {
    return [];
  }
  // Native table argument semantics are qualified against test bytes, not the
  // production code they exercise. Changed tests/helpers keep Vitest coverage.
  return candidates.filter(
    (file) =>
      matchesNativeBunSource(file, nativeBunTestHashes[file]!, cwd) &&
      Object.entries(nativeBunHelperHashes[file] ?? {}).every(([helper, sha256]) =>
        matchesNativeBunSource(helper, sha256, cwd),
      ),
  );
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
      /^--(?:maxWorkers|testTimeout|hookTimeout)=\d+$/u.test(arg) ||
      /^--exclude=[\w./-]+\.test\.[cm]?[jt]sx?$/u.test(arg),
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
  if (policy !== "node" && policy !== "bun-all" && policy !== "dual-all") {
    throw new Error(
      `Invalid OPENCLAW_CI_TEST_RUNTIME_POLICY: ${policy}; expected node, bun-all, or dual-all`,
    );
  }
  return policy;
}

function resolveAllRuntimeSelections(
  selection: TestSelection,
  policy: "bun-all" | "dual-all",
  cwd: string,
): CiTestRuntimeSelection[] {
  const node: CiTestRuntimeSelection = { runtime: "node" };
  const args = selectionVitestArgs(selection);
  const configs = selection.configs ?? [];
  const relativePath = (value: string) =>
    (path.isAbsolute(value) ? path.relative(cwd, value) : value)
      .replaceAll("\\", "/")
      .replace(/^(?:\.\.?\/)+/u, "");
  const targets = selection.targets?.map(relativePath);
  const exactTargets =
    Boolean(targets?.length) && targets!.every((file) => exactTestFilePattern.test(file));
  const ui = configs.length === 1 && configs[0] === "ui/vitest.config.ts";
  const supportsArgs = args && (ui ? supportsUiRuntime(args) : supportsRuntimePartition(args));
  const uiFiles =
    ui && supportsArgs
      ? globSync(controlUiTestGlobs, { cwd, exclude: controlUiE2eTestGlobs })
          .map((file) => file.replaceAll("\\", "/"))
          .toSorted()
      : undefined;
  const patterns = (key: string) => {
    const value = selection.env?.[key];
    return loadPatternListFromEnv(key, { [key]: typeof value === "string" ? value : undefined });
  };
  const includes = selection.includePatterns?.length
    ? selection.includePatterns
    : patterns("OPENCLAW_VITEST_INCLUDE_FILE");
  const postIncludes = patterns("OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE");
  const ownerConfigs =
    !ui && supportsArgs && !includes && !exactTargets
      ? configs.flatMap(
          (config) =>
            fullSuiteVitestShards.find((shard) => shard.config === config)?.projects ?? [config],
        )
      : [];
  const inventories = ownerConfigs.map((config) => {
    const inventory = listNodeTestConfigFiles(config);
    if (inventory) {
      return inventory;
    }
    // Focused targets can use an aggregate config while their single-project CI
    // owner already supplies the complete file inventory.
    const owner = fullSuiteVitestShards.find(
      ({ projects }) => projects?.length === 1 && projects[0] === config,
    );
    return owner ? listWholeConfigFiles(owner.name) : undefined;
  });
  const unresolvedConfigs = ownerConfigs.filter((_, index) => !inventories[index]);
  const matches = (file: string, include: readonly string[]) =>
    include.some((pattern) => {
      const relative = relativePath(pattern);
      return file
        .split("/")
        .some((_, index, parts) => matchesVitestGlob(parts.slice(index).join("/"), relative));
    });
  const files = exactTargets ? targets! : [...nodeRequiredFiles, ...bothHostFiles];
  const nodeFiles = files.filter((file) => {
    if (
      (!nodeRequiredFiles.has(file) && !bothHostFiles.has(file)) ||
      (postIncludes && !matches(file, postIncludes))
    ) {
      return false;
    }
    if (includes && !matches(file, includes)) {
      return false;
    }
    if (exactTargets) {
      return true;
    }
    if (
      targets?.length &&
      !targets.some((target) => file.includes(target) || matches(file, [target]))
    ) {
      return false;
    }
    if (includes) {
      return true;
    }
    if (!supportsArgs || !configs.length || configs.some((config) => !knownConfigs.has(config))) {
      return true;
    }
    // The package config aggregates root UI owners under a different config path.
    if (uiFiles) {
      return uiFiles.includes(file);
    }
    // Leaf inventories own membership after aggregate configs have been split.
    // Process, tooling and other unmapped owners still use the focused planner.
    return (
      inventories.some((inventory) => inventory?.includes(file)) ||
      (unresolvedConfigs.length > 0 &&
        buildVitestRunPlans([file], cwd).some((plan) => unresolvedConfigs.includes(plan.config)))
    );
  });
  const exceptions = nodeFiles.filter((file) => nodeRequiredFiles.has(file));
  if (
    (exactTargets && exceptions.length === files.length) ||
    (includes?.length && includes.every((file) => nodeRequiredFiles.has(relativePath(file))))
  ) {
    return [node];
  }
  // UI membership is applied after native sharding, preserving each row's inventory.
  if (uiFiles) {
    const bunFiles = uiFiles.filter(
      (file) => !nodeRequiredFiles.has(file) && (!postIncludes || matches(file, postIncludes)),
    );
    return [
      ...(policy === "dual-all"
        ? [node]
        : exceptions.length
          ? [
              {
                runtime: "node" as const,
                includePatterns: exceptions,
                includeAfterShard: true as const,
              },
            ]
          : []),
      { runtime: "bun", includePatterns: bunFiles, includeAfterShard: true, env: BUN_UI_TEST_ENV },
    ];
  }
  // Preserve the native engine's exact source/setup/helper hash qualification.
  if (
    !selection.env?.OPENCLAW_VITEST_INCLUDE_FILE &&
    !postIncludes &&
    args?.length === 0 &&
    (exactTargets || (configs.length === 1 && configs[0] === unitFastConfig))
  ) {
    const inventory = exactTargets
      ? targets!
      : unitFastFiles(includes ? [...includes] : undefined).filter(
          (file) => !includes || includes.some((pattern) => matchesVitestGlob(file, pattern)),
        );
    const bunFiles = inventory.filter((file) => !nodeRequiredFiles.has(file));
    const nativeFiles = qualifiedNativeBunFiles(bunFiles, cwd);
    // Exact argv is one envelope; partial native routing would change its meaning.
    if (nativeFiles.length && (!exactTargets || nativeFiles.length === inventory.length)) {
      const nativeSet = new Set(nativeFiles);
      const vitestFiles = bunFiles.filter((file) => !nativeSet.has(file));
      return [
        ...(policy === "dual-all"
          ? [node]
          : exceptions.length
            ? [
                {
                  runtime: "node" as const,
                  ...(exactTargets ? { targets: exceptions } : { includePatterns: exceptions }),
                },
              ]
            : []),
        ...(vitestFiles.length ? [{ runtime: "bun" as const, includePatterns: vitestFiles }] : []),
        { runtime: "bun", engine: "bun-test", files: nativeFiles },
      ];
    }
  }

  // Changed rows can join sibling projects. Removing Node-only files can leave a
  // project with no members, so Bun runs only projects owning a remaining file.
  const bunIncludes = includes?.map(relativePath).filter((file) => !exceptions.includes(file));
  const bunInventories =
    bunIncludes?.length && configs.length > 1
      ? configs.map((config) => listNodeTestConfigFiles(config))
      : undefined;
  const bunConfigs =
    bunInventories?.every(Boolean) &&
    bunIncludes!.every((file) => bunInventories.some((inventory) => inventory!.includes(file)))
      ? configs.filter((_, index) =>
          bunIncludes!.some((file) => bunInventories[index]!.includes(file)),
        )
      : undefined;
  return [
    ...(policy === "dual-all"
      ? [node]
      : nodeFiles.length
        ? [
            {
              runtime: "node" as const,
              ...(selection.targets?.length
                ? { targets: nodeFiles }
                : { vitestArgs: nodeFiles.map((file) => path.resolve(cwd, file)) }),
            },
          ]
        : []),
    {
      runtime: "bun",
      ...(bunConfigs && bunConfigs.length < configs.length ? { configs: bunConfigs } : {}),
      ...(ui ? { env: BUN_UI_TEST_ENV } : {}),
      // Uncertain configs/argv use Bun; only named Node contracts are excluded.
      // Absolute globs work with both repository-root and scoped Vitest dirs.
      ...(exceptions.length
        ? { vitestArgs: exceptions.map((file) => `--exclude=${path.resolve(cwd, file)}`) }
        : {}),
    },
  ];
}

export function resolveCiTestRuntimeSelections(
  selection: TestSelection,
  policy: CiTestRuntimePolicy,
  cwd = process.cwd(),
): CiTestRuntimeSelection[] {
  return policy === "node"
    ? [{ runtime: "node" }]
    : resolveAllRuntimeSelections(selection, policy, cwd);
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
