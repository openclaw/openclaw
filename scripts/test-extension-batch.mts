#!/usr/bin/env node

// Runs grouped Vitest plans for one or more bundled plugins.
import path from "node:path";
import pMap from "p-map";
import { waitForever } from "../src/cli/wait.ts";
import { assertTestHomeSelection, combineTestHomeSelections } from "../test/test-home-policy.mts";
import {
  DATABASE_WORKER_WATCH_OWNER_ENV_KEY,
  DATABASE_WORKER_WATCH_TESTS_ENV_KEY,
} from "../test/vitest/vitest.database-worker-core-paths.mjs";
import { databaseWorkerExtensionTestFiles } from "../test/vitest/vitest.extension-database-workers-paths.mjs";
import { collectVitestExcludePatterns } from "../test/vitest/vitest.pattern-file.ts";
import {
  createExtensionTestProcessTargetChunks,
  listExtensionTestFilesForRoots,
  resolveExtensionBatchPlan,
  shouldSplitExtensionTestProcesses,
  splitExtensionTestProcessTargets,
} from "./lib/extension-test-plan.mts";
import type { ExtensionBatchPlan, ExtensionTestPlanGroup } from "./lib/extension-test-plan.mts";
import {
  normalizeRelativePath,
  relativizeExtensionVitestArgs,
  relativizeExtensionVitestPath,
} from "./lib/extension-vitest-paths.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { isDirectScriptRun, runVitestBatch } from "./lib/vitest-batch-runner.mts";
import type { VitestBatchRunParams } from "./lib/vitest-batch-runner.mts";
import { prepareVitestRuntime } from "./lib/vitest-build-prerequisites.mts";
import { resolveVitestCacheRoot, resolveVitestCacheSlotPath } from "./lib/vitest-cache-slots.mts";
import { resolveExplicitVitestMode } from "./lib/vitest-cli-mode.mts";
import { resolveVitestHomeSelection } from "./lib/vitest-home-selection.mts";
import { createVitestReportOwner, type VitestReportOutcome } from "./lib/vitest-report-owner.mts";
import { resolveVitestRuntimeCliSelections } from "./lib/vitest-runtime-selection.mts";

const DATABASE_WORKER_CONFIG = "test/vitest/vitest.extension-database-workers.config.ts";
const FS_MODULE_CACHE_PATH_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH";
const PARALLEL_ENV_KEY = "OPENCLAW_EXTENSION_BATCH_PARALLEL";
const ALLOW_NO_TESTS_FLAG = "--allow-no-tests";
const ALLOW_EMPTY_AFTER_EXCLUDE_FLAG = "--allow-empty-after-exclude";

function printUsage() {
  console.error(
    `Usage: pnpm test:extensions:batch <extension[,extension...]> [${ALLOW_NO_TESTS_FLAG}] [${ALLOW_EMPTY_AFTER_EXCLUDE_FLAG}] [vitest args...]`,
  );
  console.error(
    `       node --import tsx scripts/test-extension-batch.mts <extension[,extension...]> [${ALLOW_NO_TESTS_FLAG}] [${ALLOW_EMPTY_AFTER_EXCLUDE_FLAG}] [vitest args...]`,
  );
}

/**
 * Parses comma-separated plugin ids and separates Vitest passthrough args.
 */
export function parseExtensionIds(rawArgs: string[]) {
  const normalizedArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const separatorIndex = normalizedArgs.indexOf("--");
  const args = separatorIndex >= 0 ? normalizedArgs.slice(0, separatorIndex) : [...normalizedArgs];
  const separatorPassthroughArgs =
    separatorIndex >= 0 ? normalizedArgs.slice(separatorIndex + 1) : [];
  const extensionIds: string[] = [];

  while (args[0] && !args[0].startsWith("-")) {
    const extensionArg = args.shift();
    if (!extensionArg) {
      break;
    }
    extensionIds.push(
      ...extensionArg
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  return {
    extensionIds,
    passthroughArgs: separatorIndex >= 0 ? [...args, ...separatorPassthroughArgs] : args,
  };
}

/**
 * Resolves bounded parallelism for extension test config groups.
 */
export function resolveExtensionBatchParallelism(groupCount: number, env = process.env) {
  const raw = env[PARALLEL_ENV_KEY]?.trim();
  const override = raw ? parsePositiveInt(raw, PARALLEL_ENV_KEY) : 1;
  return Math.min(Math.max(1, override), Math.max(1, groupCount));
}

function createGroupEnv({
  baseEnv,
  group,
  watchMode,
}: {
  baseEnv: NodeJS.ProcessEnv;
  group: ExtensionTestPlanGroup;
  watchMode: boolean;
}) {
  if (watchMode || baseEnv[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim()) {
    return baseEnv;
  }

  return {
    ...baseEnv,
    [FS_MODULE_CACHE_PATH_ENV_KEY]: resolveVitestCacheSlotPath(
      resolveVitestCacheRoot(baseEnv),
      group.config,
    ),
  };
}

function orderPlanGroups(planGroups: ExtensionTestPlanGroup[], parallelism: number) {
  if (parallelism <= 1) {
    return planGroups;
  }
  return [...planGroups].toSorted((left, right) => {
    if (left.estimatedCost !== right.estimatedCost) {
      return right.estimatedCost - left.estimatedCost;
    }
    if (left.testFileCount !== right.testFileCount) {
      return right.testFileCount - left.testFileCount;
    }
    return left.config.localeCompare(right.config);
  });
}

function isExactExcludePath(inputPath: string) {
  return !/[*!?[\]{}]/u.test(inputPath);
}

function addExactExcludePath(excludePaths: Set<string>, value: string) {
  const normalized = normalizeRelativePath(value);
  excludePaths.add(normalized);
  if (!normalized.startsWith("extensions/")) {
    excludePaths.add(`extensions/${normalized}`);
  }
}

/**
 * Collects exact --exclude paths so empty groups can be reported accurately.
 */
export function parseExactVitestExcludePaths(vitestArgs: string[]) {
  const excludePaths = new Set<string>();
  for (const value of collectVitestExcludePatterns(vitestArgs)) {
    if (isExactExcludePath(value)) {
      addExactExcludePath(excludePaths, value);
    }
  }
  return excludePaths;
}

function resolveGroupTargets(group: ExtensionTestPlanGroup, exactExcludePaths: Set<string>) {
  if (exactExcludePaths.size === 0) {
    return group.roots;
  }

  const testFiles = listExtensionTestFilesForRoots(group.roots);
  if (!testFiles) {
    return group.roots;
  }

  return testFiles.filter(
    (file) =>
      !exactExcludePaths.has(file) &&
      (group.config === DATABASE_WORKER_CONFIG || !databaseWorkerExtensionTestFiles.includes(file)),
  );
}

function preparePlanGroup(
  group: ExtensionTestPlanGroup,
  env: NodeJS.ProcessEnv,
  vitestArgs: string[],
  exactExcludePaths: Set<string>,
) {
  const targets = resolveGroupTargets(group, exactExcludePaths);
  const targetChunks =
    targets.length === 0
      ? []
      : exactExcludePaths.size > 0
        ? shouldSplitExtensionTestProcesses(group.config, vitestArgs)
          ? splitExtensionTestProcessTargets(group.config, targets)
          : [targets]
        : createExtensionTestProcessTargetChunks(group.config, group.roots, vitestArgs);
  return {
    group,
    invocations: targetChunks.map<VitestBatchRunParams & { env: NodeJS.ProcessEnv }>((chunk) => ({
      args: relativizeExtensionVitestArgs(vitestArgs),
      config: group.config,
      env: createGroupEnv({
        baseEnv: env,
        group,
        watchMode: resolveExplicitVitestMode(["run", ...vitestArgs]) === "watch",
      }),
      targets: chunk.map((target) => relativizeExtensionVitestPath(target)),
    })),
  };
}

function combineSinglePluginGroups(
  preparedGroups: ReturnType<typeof preparePlanGroup>[],
  vitestArgs: string[],
  env: NodeJS.ProcessEnv,
  homeMode: VitestBatchRunParams["homeMode"],
): ReturnType<typeof preparePlanGroup>[] {
  const worker = preparedGroups.find(({ group }) => group.config === DATABASE_WORKER_CONFIG);
  const owner = preparedGroups.find(({ group }) => group.config !== DATABASE_WORKER_CONFIG);
  if (
    preparedGroups.length !== 2 ||
    !worker ||
    !owner ||
    shouldSplitExtensionTestProcesses(DATABASE_WORKER_CONFIG, vitestArgs)
  ) {
    return preparedGroups;
  }
  const targets = [
    ...new Set(
      preparedGroups.flatMap(({ invocations }) =>
        invocations.flatMap((invocation) => invocation.targets),
      ),
    ),
  ];
  const config = "test/vitest/vitest.database-worker-watch.config.ts";
  return [
    {
      group: { ...owner.group, config },
      invocations:
        targets.length === 0
          ? []
          : [
              {
                config,
                args: relativizeExtensionVitestArgs(vitestArgs),
                targets: targets.filter(
                  (target) => !targets.some((root) => target.startsWith(`${root}/`)),
                ),
                env: {
                  ...createGroupEnv({
                    baseEnv: env,
                    group: { ...owner.group, config },
                    watchMode: resolveExplicitVitestMode(["run", ...vitestArgs]) === "watch",
                  }),
                  [DATABASE_WORKER_WATCH_OWNER_ENV_KEY]: owner.group.config,
                  [DATABASE_WORKER_WATCH_TESTS_ENV_KEY]: JSON.stringify(worker.group.roots),
                },
                homeMode,
              },
            ],
    },
  ];
}

async function runPlanGroup(
  { group, invocations }: ReturnType<typeof preparePlanGroup>,
  runGroup: (params: ReturnType<typeof preparePlanGroup>["invocations"][number]) => Promise<number>,
  allowEmptyAfterExclude: boolean,
  isCancelled: () => boolean,
) {
  if (invocations.length === 0) {
    console.error(`[test-extension-batch] ${group.config}: no test files remain after excludes`);
    return allowEmptyAfterExclude ? 0 : 1;
  }
  let finalExitCode = 0;
  for (const [index, invocation] of invocations.entries()) {
    if (isCancelled()) {
      break;
    }
    console.log(
      `[test-extension-batch] ${group.config}: ${group.extensionIds.join(", ")} (${invocation.targets.length} targets${invocations.length > 1 ? `, chunk ${index + 1}/${invocations.length}` : ""})`,
    );
    const exitCode = await runGroup(invocation);
    if (exitCode !== 0 && finalExitCode === 0) {
      finalExitCode = exitCode;
    }
  }
  return finalExitCode;
}

/**
 * Runs a resolved extension batch plan, optionally in parallel config groups.
 */
export async function runExtensionBatchPlan(
  batchPlan: ExtensionBatchPlan,
  params: {
    allowEmptyAfterExclude?: boolean;
    expandExactExcludes?: boolean;
    env?: NodeJS.ProcessEnv;
    runGroup?: (params: VitestBatchRunParams) => Promise<number>;
    vitestArgs?: string[];
  } = {},
) {
  const env = params.env ?? process.env;
  const vitestArgs = params.vitestArgs ?? [];
  // Single-plugin CLI historically leaves exact exclusions to Vitest.
  const exactExcludePaths =
    params.expandExactExcludes === false
      ? new Set<string>()
      : parseExactVitestExcludePaths(vitestArgs);
  const runGroup = params.runGroup ?? runVitestBatch;
  const parallelism = resolveExtensionBatchParallelism(batchPlan.planGroups.length, env);
  const orderedGroups = orderPlanGroups(batchPlan.planGroups, parallelism);
  const allowEmptyAfterExclude = params.allowEmptyAfterExclude ?? false;

  if (parallelism > 1) {
    console.log(`[test-extension-batch] Running up to ${parallelism} config groups in parallel`);
  }

  const leafGroups = orderedGroups.map((group) =>
    preparePlanGroup(group, env, vitestArgs, exactExcludePaths),
  );
  const leafInvocations = leafGroups.flatMap((group) => group.invocations);
  const cwd = path.resolve(import.meta.dirname, "..");
  const homeMode = combineTestHomeSelections(
    leafInvocations.map(({ config, args, targets, env: invocationEnv }) =>
      resolveVitestHomeSelection(["--config", config, ...args, ...targets], {
        cwd,
        env: invocationEnv,
      }),
    ),
  );
  // Admit the whole selection before report or runtime preparation can import code.
  assertTestHomeSelection(env, homeMode);
  const preparedGroups =
    batchPlan.extensionCount === 1
      ? combineSinglePluginGroups(leafGroups, vitestArgs, env, homeMode)
      : leafGroups;
  const invocations = preparedGroups.flatMap((group) => group.invocations);
  const reports = await createVitestReportOwner(
    invocations.map((invocation) => ({
      config: invocation.config,
      args: ["run", "--config", invocation.config, ...invocation.args, ...invocation.targets],
    })),
    cwd,
  );
  const termination: { signal: NodeJS.Signals | null } = { signal: null };
  const onSignal = (value: NodeJS.Signals) => {
    termination.signal ??= value;
  };
  if (reports) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }
  let reportFailure: string | undefined;
  let exitCode = 0;
  const started: Promise<unknown>[] = [];
  const runInvocation = async (
    invocation: ReturnType<typeof preparePlanGroup>["invocations"][number],
  ) => {
    const attempt = reports?.attempt(invocations.indexOf(invocation), invocation.args);
    if (!attempt) {
      return runGroup(invocation);
    }
    try {
      let outcome: VitestReportOutcome | undefined;
      const code = await runGroup({
        ...invocation,
        args: attempt.args,
        onComplete(value) {
          outcome = value;
          termination.signal ??= value.signal;
        },
      });
      attempt.complete(outcome ?? { code, signal: null });
      return code;
    } catch (error) {
      attempt.fail(error);
      throw error;
    }
  };
  try {
    // No reader may start while a shared generation is being replaced. Select
    // from the exact emitted chunks, including existing exact-exclude expansion.
    const preparationCode = await prepareVitestRuntime(
      leafInvocations.flatMap(({ config, args, targets, env: invocationEnv }) =>
        resolveVitestRuntimeCliSelections(config, [...args, ...targets], invocationEnv),
      ),
      env,
    );
    if (preparationCode !== 0) {
      exitCode = preparationCode;
      reportFailure = "Runtime preparation failed; invocations unstarted";
      return exitCode;
    }
    try {
      await pMap(
        preparedGroups,
        async (group) => {
          if ((exitCode !== 0 && batchPlan.extensionCount > 1) || termination.signal) {
            return;
          }
          const running = runPlanGroup(
            group,
            runInvocation,
            allowEmptyAfterExclude,
            () => termination.signal !== null,
          ).then((groupExitCode) => {
            if (groupExitCode !== 0 && exitCode === 0) {
              exitCode = groupExitCode;
            }
          });
          started.push(running);
          await running;
        },
        { concurrency: parallelism, stopOnError: true },
      );
    } finally {
      await Promise.allSettled(started);
    }
  } catch (error) {
    reportFailure = String(error);
    throw error;
  } finally {
    if (reports) {
      try {
        const reportCode = await reports.finish(
          async (mergeArgs) => {
            const args = mergeArgs.slice(1);
            const configIndex = args.indexOf("--config");
            const config = args.splice(configIndex, 2)[1]!;
            let outcome: VitestReportOutcome | undefined;
            const code = await runVitestBatch({
              config,
              args,
              targets: [],
              env,
              homeMode,
              onComplete(value) {
                outcome = value;
                termination.signal ??= value.signal;
              },
            });
            return outcome ?? { code, signal: null };
          },
          termination.signal ? `Cancelled by ${termination.signal}` : reportFailure,
        );
        exitCode ||= reportCode;
      } finally {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        if (termination.signal) {
          process.kill(process.pid, termination.signal);
          // Keep the loop alive for dependency signal handlers to finish cleanup
          // and re-raise; a numeric return can win the race with signal delivery.
          await waitForever();
        }
      }
    }
  }
  return exitCode;
}

async function run() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const allowNoTests = rawArgs.includes(ALLOW_NO_TESTS_FLAG);
  const allowEmptyAfterExclude = rawArgs.includes(ALLOW_EMPTY_AFTER_EXCLUDE_FLAG);
  const controlArgs = new Set([ALLOW_NO_TESTS_FLAG, ALLOW_EMPTY_AFTER_EXCLUDE_FLAG]);
  const args = rawArgs.filter((arg) => !controlArgs.has(arg));
  const { extensionIds, passthroughArgs: vitestArgs } = parseExtensionIds(args);
  if (extensionIds.length === 0) {
    printUsage();
    process.exit(1);
  }

  const batchPlan = resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds });
  const noTestExtensionIds = batchPlan.noTestExtensionIds ?? [];
  if (noTestExtensionIds.length > 0 && !allowNoTests) {
    console.error(
      `[test-extension-batch] No tests found for requested extension(s): ${noTestExtensionIds.join(", ")}`,
    );
    process.exit(1);
  }
  if (!batchPlan.hasTests) {
    console.error("[test-extension-batch] No tests found for the requested extensions.");
    if (!allowNoTests) {
      process.exit(1);
    }
    return;
  }

  console.log(
    `[test-extension-batch] Running ${batchPlan.testFileCount} test files across ${batchPlan.extensionCount} extensions`,
  );

  const exitCode = await runExtensionBatchPlan(batchPlan, {
    allowEmptyAfterExclude,
    env: process.env,
    vitestArgs,
  });
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

if (isDirectScriptRun(import.meta.url)) {
  await run();
}
