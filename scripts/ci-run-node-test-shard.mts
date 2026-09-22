// Runs one CI node test shard job: either explicit changed-test targets or a
// list of packed group plans. Extracted from .github/workflows/ci.yml so the
// execution policy is unit-testable and plans can run concurrently.
import { spawn, type ChildProcess } from "node:child_process";
import {
  constants,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { decodeNodeTestGroups } from "./lib/ci-node-test-groups-codec.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { isConstrainedCiCheckHost, isExclusiveCiTestConfig } from "./lib/local-check-runtime.mts";
import { parsePositiveInt, readPositiveEnvInt } from "./lib/numeric-options.mjs";
import type { VitestWorkerRun } from "./lib/vitest-worker-run.mts";

// CI admits at most two plans only when the actual host has room. Each plan
// keeps inner test-projects parallelism 1; runner labels cannot establish capacity.
const PLAN_CONCURRENCY = 2;
const FS_MODULE_CACHE_PATH_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH";
const FS_MODULE_CACHE_WRITER_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER";
const NODE_COMPILE_CACHE_PATH_ENV_KEY = "NODE_COMPILE_CACHE";
const NODE_COMPILE_CACHE_WRITER_ENV_KEY = "OPENCLAW_NODE_COMPILE_CACHE_WRITER";
const VITEST_EXTRA_ARGS_ENV_KEY = "OPENCLAW_NODE_TEST_VITEST_ARGS_JSON";
const FS_MODULE_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const NODE_COMPILE_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const FS_MODULE_CACHE_PRUNE_TARGET_RATIO = 0.75;
const FS_MODULE_CACHE_METADATA_FILE = "_metadata.json";
const FS_MODULE_CACHE_GENERATION_FILE = ".openclaw-transform-generation";

export type ShardTargetPlan = { kind: "target"; name: string; target: string };
type ShardGroupConfig = {
  configs: string[];
  fallbackMaxWorkers?: number;
  minTotalMemoryBytes?: number;
  env?: Record<string, unknown> | null;
  includePatterns?: string[] | null;
  shard_name?: string;
  timing_key?: string;
};
export type ShardGroupPlan = {
  kind: "group";
  name: string;
  plan: ShardGroupConfig;
  timingKey?: string;
};
export type ShardPlan = ShardTargetPlan | ShardGroupPlan;
type RunShardOptions = {
  concurrency?: number;
  continueOnFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  fsModuleCacheMaxBytes?: number;
  nodeCompileCacheMaxBytes?: number;
  runChild?: typeof runChild;
  scratchDir?: string;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isShardGroupConfig(value: unknown): value is ShardGroupConfig {
  return isRecord(value) && isStringArray(value.configs);
}

function parseJsonEnv(
  env: Record<string, unknown>,
  name: string,
  fallback: unknown = null,
): unknown {
  try {
    const value = env[name];
    return typeof value === "string" ? (JSON.parse(value) ?? fallback) : fallback;
  } catch {
    return fallback;
  }
}

export function resolveShardPlans(env: NodeJS.ProcessEnv = process.env): ShardPlan[] {
  const targets = parseJsonEnv(env, "OPENCLAW_NODE_TEST_TARGETS_JSON");
  if (isStringArray(targets) && targets.length > 0) {
    // One target per child process preserves the isolation boundaries encoded
    // by full-suite include-pattern shards while keeping one runner job.
    return targets.map((target) => ({ kind: "target", name: target, target }));
  }

  // The CI manifest packs matrix groups so preflight's job outputs stay under
  // GitHub's 1 MiB UTF-16 cap. Plain JSON remains for the Vitest cache warmer,
  // which writes its small group list straight into GITHUB_ENV.
  const packedGroups = env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64?.trim();
  const groups = packedGroups
    ? decodeNodeTestGroups(packedGroups)
    : parseJsonEnv(env, "OPENCLAW_NODE_TEST_GROUPS_JSON");
  const groupPlans = Array.isArray(groups) ? groups.filter(isShardGroupConfig) : [];
  const configs = parseJsonEnv(env, "OPENCLAW_NODE_TEST_CONFIGS_JSON", []);
  const groupEnv = parseJsonEnv(env, "OPENCLAW_NODE_TEST_ENV_JSON");
  const includePatterns = parseJsonEnv(env, "OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON");
  const plans: ShardGroupConfig[] =
    groupPlans.length > 0
      ? groupPlans
      : [
          {
            configs: isStringArray(configs) ? configs : [],
            env: isRecord(groupEnv) ? groupEnv : null,
            includePatterns: isStringArray(includePatterns) ? includePatterns : null,
            shard_name: env.OPENCLAW_VITEST_SHARD_NAME,
          },
        ];
  return plans.map((plan) => {
    const name = plan.shard_name ?? plan.configs?.[0] ?? "group";
    return { kind: "group", name, plan, timingKey: plan.timing_key ?? name };
  });
}

function mergePlanEnv(baseEnv: NodeJS.ProcessEnv, overrides: unknown): NodeJS.ProcessEnv {
  const childEnv = { ...baseEnv };
  if (isRecord(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === "string") {
        const inherited = baseEnv[key]?.trim();
        // Pins may lower the admitted job budget, never raise it. Compiler
        // preparation and test children must inherit the same intersection.
        childEnv[key] =
          key === "OPENCLAW_VITEST_MAX_WORKERS" && inherited
            ? String(
                Math.min(
                  parsePositiveInt(inherited, key),
                  parsePositiveInt(value.trim() || inherited, key),
                ),
              )
            : value;
      }
    }
  }
  return childEnv;
}

function prepareChildEnv(entry: ShardPlan, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return mergePlanEnv(
    {
      ...baseEnv,
      OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
      ...(entry.kind === "group" && entry.plan.shard_name
        ? { OPENCLAW_VITEST_SHARD_NAME: entry.plan.shard_name }
        : {}),
    },
    entry.kind === "group" ? entry.plan.env : undefined,
  );
}

export function buildChildEnv(
  entry: ShardPlan,
  baseEnv: NodeJS.ProcessEnv,
  scratchDir: string,
  index: number,
  options: { serial?: boolean; cacheSlot?: number; runtime?: "node" | "bun" } = {},
) {
  const persistentCacheRoot = baseEnv[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim();
  const cachePrefix = options.runtime === "bun" ? "vitest-cache-bun" : "vitest-cache";
  const cacheDirectory = persistentCacheRoot
    ? `${cachePrefix}-${options.cacheSlot ?? index}`
    : options.serial
      ? `${cachePrefix}-shared`
      : `${cachePrefix}-${index}`;
  // Persistent worker slots let serial plans reuse transforms without concurrent
  // writers. Scratch caches stay per-plan; group overrides still apply last.
  const childEnv = prepareChildEnv(entry, {
    ...baseEnv,
    [FS_MODULE_CACHE_PATH_ENV_KEY]: join(persistentCacheRoot || scratchDir, cacheDirectory),
  });
  if (options.runtime) {
    childEnv.OPENCLAW_VITEST_RUNTIME = options.runtime;
  }
  if (entry.kind === "group") {
    const plan = entry.plan;
    if (Array.isArray(plan.includePatterns) && plan.includePatterns.length > 0) {
      const includeFile = join(scratchDir, `node-test-include-${index}.json`);
      writeFileSync(includeFile, JSON.stringify(plan.includePatterns), "utf8");
      childEnv.OPENCLAW_VITEST_INCLUDE_FILE = includeFile;
    } else {
      delete childEnv.OPENCLAW_VITEST_INCLUDE_FILE;
    }
  }
  return childEnv;
}

export function pruneFsModuleCache(root: string, maxBytes = FS_MODULE_CACHE_MAX_BYTES) {
  if (!root || !existsSync(root) || !Number.isFinite(maxBytes) || maxBytes < 0) {
    return { beforeBytes: 0, afterBytes: 0, removedFiles: 0 };
  }

  const files: Array<{ filePath: string; mtimeMs: number; size: number }> = [];
  let totalBytes = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const fileStat = statSync(filePath);
      totalBytes += fileStat.size;
      if (
        entry.name !== FS_MODULE_CACHE_METADATA_FILE &&
        entry.name !== FS_MODULE_CACHE_GENERATION_FILE
      ) {
        files.push({ filePath, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
      }
    }
  };
  visit(root);

  const beforeBytes = totalBytes;
  if (totalBytes <= maxBytes) {
    return { beforeBytes, afterBytes: totalBytes, removedFiles: 0 };
  }

  const targetBytes = Math.floor(maxBytes * FS_MODULE_CACHE_PRUNE_TARGET_RATIO);
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let removedFiles = 0;
  for (const file of files) {
    if (totalBytes <= targetBytes) {
      break;
    }
    unlinkSync(file.filePath);
    totalBytes -= file.size;
    removedFiles += 1;
  }
  return { beforeBytes, afterBytes: totalBytes, removedFiles };
}

export function clonePersistentCacheSlots(root: string | undefined, concurrency: number) {
  if (!root || concurrency <= 1) {
    return 0;
  }
  const seed = join(root, "vitest-cache-0");
  if (!existsSync(seed)) {
    return 0;
  }

  let clonedSlots = 0;
  for (let cacheSlot = 1; cacheSlot < concurrency; cacheSlot += 1) {
    const destination = join(root, `vitest-cache-${cacheSlot}`);
    rmSync(destination, { force: true, recursive: true });
    // Clone before workers start. Reflinks make the common Linux path cheap;
    // unsupported filesystems transparently fall back to a regular copy.
    cpSync(seed, destination, {
      mode: constants.COPYFILE_FICLONE,
      recursive: true,
    });
    clonedSlots += 1;
  }
  return clonedSlots;
}

const MAX_PENDING_LINE_CHARS = 1_000_000;

function relayChildStream(stream: Readable, label: string) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const writeLine = (line: string) => {
    if (!process.stdout.write(`[shard:${label}] ${line}\n`)) {
      stream.pause();
      process.stdout.once("drain", () => stream.resume());
    }
  };
  stream.on("data", (chunk: Buffer | string) => {
    pending += decoder.write(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      writeLine(line);
    }
    if (pending.length > MAX_PENDING_LINE_CHARS) {
      writeLine(pending);
      pending = "";
    }
  });
  return () => {
    pending += decoder.end();
    if (pending !== "") {
      writeLine(pending);
      pending = "";
    }
  };
}

const TEST_PROJECTS_ENTRYPOINTS = ["scripts/test-projects.mts", "scripts/test-projects.mjs"];

export function resolveTestProjectsEntrypoint(
  fileExists: (path: string) => boolean = existsSync,
): string {
  const entrypoint = TEST_PROJECTS_ENTRYPOINTS.find((candidate) => fileExists(candidate));
  if (!entrypoint) {
    throw new Error("CI target does not provide scripts/test-projects.mts or .mjs");
  }
  return entrypoint;
}

export function resolveShardChildCommand(
  args: string[],
  nodeExecPath = process.execPath,
  testProjectsEntrypoint = resolveTestProjectsEntrypoint(),
  workerRun?: VitestWorkerRun,
) {
  const loaderArgs = testProjectsEntrypoint.endsWith(".mts") ? ["--import", "tsx"] : [];
  return {
    command: nodeExecPath,
    args: [
      ...loaderArgs,
      ...(workerRun
        ? [
            fileURLToPath(new URL("./lib/vitest-worker-bootstrap.mts", import.meta.url)),
            workerRun.descriptor.directory,
          ]
        : []),
      testProjectsEntrypoint,
      ...args,
    ],
  };
}

async function createWorkerContext(env: NodeJS.ProcessEnv, plans: ShardPlan[]) {
  const ownedRunner = join(process.cwd(), "scripts/ci-run-node-test-shard.mts");
  // ci.yml's five-file frozen-release adapter must execute the old target,
  // never load a modern compiler from its workflow-owned .ci-workflow checkout.
  if (
    fileURLToPath(import.meta.url) ===
      join(process.cwd(), ".ci-workflow/scripts/ci-run-node-test-shard.mts") &&
    !existsSync(ownedRunner)
  ) {
    return undefined;
  }
  if (fileURLToPath(import.meta.url) !== ownedRunner) {
    throw new Error("Compiled CI worker ownership requires the target's own shard runner");
  }
  const groupOwner = await import("./vitest-process-group.mts");
  // Windows' portable entry keeps per-group owners: a close-only receipt cannot
  // authorize deleting a generation shared with another group's descendants.
  if (!groupOwner.shouldUseDetachedVitestProcessGroup()) {
    return undefined;
  }
  const { resolveSharedVitestCompilerEnv } = await import("./lib/vitest-process-env.mts");
  const compilerEnv = resolveSharedVitestCompilerEnv(
    plans.length > 0 ? plans.map((plan) => prepareChildEnv(plan, env)) : [env],
  );
  const [worker, processOwner] = await Promise.all([
    import("./lib/vitest-worker-run.mts"),
    import("./lib/vitest-process.mts"),
  ]);
  return {
    workerRun: worker.createVitestWorkerRun(compilerEnv),
    spawn: processOwner.spawnOwnedVitestProcess,
    exitBySignal: processOwner.exitVitestBySignal,
    installCleanup: groupOwner.installVitestProcessGroupCleanup,
  };
}

async function runChild(
  args: string[],
  childEnv: NodeJS.ProcessEnv,
  label: string,
  timingKey: string,
  context?: Awaited<ReturnType<typeof createWorkerContext>>,
) {
  // Use Node directly. `pnpm exec node` may reconcile the workspace before
  // tests, which destroys the sticky dependency fast path.
  const childCommand = resolveShardChildCommand(
    args,
    process.execPath,
    undefined,
    context?.workerRun,
  );
  let child: ChildProcess;
  let completion: Promise<number>;
  let teardown: (() => void) | undefined;
  if (context) {
    const owned = context.spawn({
      command: childCommand.command,
      args: childCommand.args,
      options: {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
      homeMode: "tooling",
    });
    child = owned.child;
    teardown = context.installCleanup({
      child,
      forceSignal: "SIGKILL",
      forceSignalDelayMs: 100,
    }).teardown;
    // The containing TMP owner preserves nested claims if a group parent dies.
    completion = context.workerRun.borrow(
      child,
      owned.completion.then((result) => {
        if (!result.groupJoined) {
          throw new Error("CI group descendant completion is unverified");
        }
        return result.code ?? 1;
      }),
    );
  } else {
    child = spawn(childCommand.command, childCommand.args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    completion = new Promise<number>((resolve) => {
      child.once("close", (code) => resolve(code ?? 1));
      child.once("error", (error) => {
        process.stdout.write(`[shard:${label}] failed to spawn: ${error}\n`);
        resolve(1);
      });
    });
  }
  // Stream with a per-line label instead of buffering: children can run
  // whole suites for hours and verbose output must not accumulate on the
  // wrapper heap. Backpressure pauses the child stream while stdout drains,
  // and an oversized newline-free tail is force-flushed so the pending
  // partial line stays bounded too.
  const flushers = [child.stdout!, child.stderr!].map((stream) => relayChildStream(stream, label));
  process.stdout.write(`[shard:${timingKey}] begin\n`);
  let code: number;
  try {
    code = await completion;
  } finally {
    for (const flush of flushers) {
      flush();
    }
    teardown?.();
  }
  process.stdout.write(`[shard:${timingKey}] end (exit ${code})\n`);
  return code;
}

export async function runShardPlans(plans: ShardPlan[], options: RunShardOptions = {}) {
  const inheritedEnv = options.env ?? process.env;
  const jobEnv = mergePlanEnv({}, parseJsonEnv(inheritedEnv, "OPENCLAW_NODE_TEST_ENV_JSON"));
  const baseEnv = mergePlanEnv(inheritedEnv, jobEnv);
  // Historical targets use a five-file workflow-owned adapter. Their Node
  // contract must not import current target discovery or runtime policy code.
  const runtimePolicy = baseEnv.OPENCLAW_CI_TEST_RUNTIME_POLICY?.trim() || "node";
  const runtimeOwner =
    runtimePolicy === "node" ? undefined : await import("./lib/ci-test-runtime.mts");
  const policy = runtimeOwner?.resolveCiTestRuntimePolicy(baseEnv) ?? "node";
  // Respect serial timing-sensitive bins and never clone cache slots that
  // cannot receive a plan.
  const requestedConcurrency =
    options.concurrency === undefined
      ? readPositiveEnvInt("OPENCLAW_NODE_TEST_PLAN_CONCURRENCY", baseEnv, PLAN_CONCURRENCY)
      : parsePositiveInt(options.concurrency, "Shard plan concurrency");
  const ci = baseEnv.CI === "true" || baseEnv.GITHUB_ACTIONS === "true";
  const hostResources = ci
    ? { logicalCpuCount: os.availableParallelism(), totalMemoryBytes: os.totalmem() }
    : null;
  const concurrency = Math.min(
    plans.length,
    requestedConcurrency,
    // Cold in-process Gateway boot costs 37s quiet / 50s contended against a 90s
    // budget. A job containing these configs must never admit a second plan.
    plans.some(
      (entry) => entry.kind === "group" && entry.plan.configs.some(isExclusiveCiTestConfig),
    )
      ? 1
      : requestedConcurrency,
    hostResources
      ? isConstrainedCiCheckHost(hostResources)
        ? 1
        : PLAN_CONCURRENCY
      : requestedConcurrency,
  );
  if (hostResources) {
    console.log(
      `[shard:resources] logicalCpuCount=${hostResources.logicalCpuCount} totalMemoryBytes=${hostResources.totalMemoryBytes} requested plans=${requestedConcurrency} admitted plans=${concurrency}`,
    );
  }
  const measuredHost =
    hostResources !== null &&
    !isConstrainedCiCheckHost(hostResources) &&
    concurrency === 1 &&
    baseEnv.RUNNER_ENVIRONMENT === "self-hosted" &&
    baseEnv.FROZEN_TARGET !== "true"
      ? hostResources
      : null;
  const admittedPlans = plans.map((entry): ShardPlan => {
    if (entry.kind !== "group" || entry.plan.fallbackMaxWorkers === undefined) {
      return entry;
    }
    const fallback = parsePositiveInt(entry.plan.fallbackMaxWorkers, "Fallback worker limit");
    const minTotalMemoryBytes =
      entry.plan.minTotalMemoryBytes === undefined
        ? 0
        : parsePositiveInt(entry.plan.minTotalMemoryBytes, "Worker memory floor");
    if (measuredHost && measuredHost.totalMemoryBytes >= minTotalMemoryBytes) {
      return entry;
    }
    return {
      ...entry,
      plan: {
        ...entry.plan,
        env: mergePlanEnv(mergePlanEnv({}, entry.plan.env), {
          OPENCLAW_VITEST_MAX_WORKERS: String(fallback),
        }),
      },
    };
  });
  const scratchDir = options.scratchDir ?? mkdtempSync(join(tmpdir(), "openclaw-node-shard-"));
  const persistentCacheRoot = baseEnv[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim();
  const nodeCompileCacheRoot = baseEnv[NODE_COMPILE_CACHE_PATH_ENV_KEY]?.trim();
  const clonedCacheSlots = clonePersistentCacheSlots(persistentCacheRoot, concurrency);
  if (clonedCacheSlots > 0) {
    process.stdout.write(
      `[shard:cache] cloned restored Vitest seed into ${clonedCacheSlots} isolated lane(s)\n`,
    );
  }

  const context = await createWorkerContext(baseEnv, admittedPlans);
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
  };
  if (context) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  try {
    const runner: typeof runChild =
      options.runChild ??
      ((args, childEnv, label, timingKey) => runChild(args, childEnv, label, timingKey, context));
    let nextIndex = 0;
    let exitCode = 0;
    const workers = Array.from({ length: concurrency }, async (_, cacheSlot) => {
      try {
        while (nextIndex < admittedPlans.length && (exitCode === 0 || options.continueOnFailure)) {
          if (interrupted) {
            return;
          }
          const index = nextIndex;
          nextIndex += 1;
          const entry = admittedPlans[index];
          if (!entry) {
            return;
          }
          const targetArgs = entry.kind === "target" ? [entry.target] : entry.plan.configs;
          if (!Array.isArray(targetArgs) || targetArgs.length === 0) {
            console.error(`Missing node test shard configs for ${entry.name}`);
            exitCode = exitCode || 1;
            if (!options.continueOnFailure) {
              return;
            }
            continue;
          }
          // A standalone plan already projects the job environment. Resolve its
          // scoped override once, then append it to the inherited global flags.
          const vitestExtraArgs = [
            inheritedEnv,
            mergePlanEnv(jobEnv, entry.kind === "group" ? entry.plan.env : undefined),
          ].flatMap((env) => {
            const value = parseJsonEnv(env, VITEST_EXTRA_ARGS_ENV_KEY, []);
            return isStringArray(value) ? value : [];
          });
          const args =
            vitestExtraArgs.length > 0 ? [...targetArgs, "--", ...vitestExtraArgs] : targetArgs;
          const selections = runtimeOwner?.resolveCiTestRuntimeSelections(
            {
              ...(entry.kind === "target" ? { targets: [entry.target] } : entry.plan),
              env: prepareChildEnv(entry, baseEnv),
              vitestArgs: vitestExtraArgs,
            },
            policy,
          ) ?? [{ runtime: "node" as const }];
          for (const selection of selections) {
            if (interrupted) {
              return;
            }
            const runtime = selection.runtime;
            const selectedEntry =
              entry.kind === "group" && selection.includePatterns
                ? { ...entry, plan: { ...entry.plan, includePatterns: selection.includePatterns } }
                : entry;
            const childEnv = buildChildEnv(selectedEntry, baseEnv, scratchDir, index, {
              serial: concurrency === 1,
              cacheSlot,
              runtime,
            });
            if (selection.includeAfterShard) {
              childEnv.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE =
                childEnv.OPENCLAW_VITEST_INCLUDE_FILE;
              delete childEnv.OPENCLAW_VITEST_INCLUDE_FILE;
            }
            Object.assign(childEnv, selection.env);
            const timingKey = entry.kind === "group" ? (entry.timingKey ?? entry.name) : entry.name;
            const timingPrefix =
              runtime === "bun" ? "bun:" : selection.includePatterns ? "node-subset:" : "";
            const code = await runner(
              args,
              childEnv,
              `${timingPrefix}${entry.name}`,
              `${timingPrefix}${timingKey}`,
            );
            // A dual-runtime envelope always completes both ordinary test runs;
            // its first failure still stops admission of later envelopes.
            if (code !== 0) {
              exitCode = exitCode || code;
            }
          }
        }
      } catch (error) {
        // Setup failures stop admission immediately; live children still own
        // their cache slots until every admitted worker has joined.
        nextIndex = admittedPlans.length;
        throw error;
      }
    });
    const outcomes = await Promise.allSettled(workers);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected) {
      throw rejected.reason;
    }
    if (persistentCacheRoot && baseEnv[FS_MODULE_CACHE_WRITER_ENV_KEY] === "1") {
      try {
        const pruned = pruneFsModuleCache(
          persistentCacheRoot,
          options.fsModuleCacheMaxBytes ?? FS_MODULE_CACHE_MAX_BYTES,
        );
        process.stdout.write(
          `[shard:cache] vitest ${pruned.beforeBytes} -> ${pruned.afterBytes} bytes; removed ${pruned.removedFiles} files\n`,
        );
      } catch (error) {
        console.warn(`[shard:cache] failed to prune Vitest cache: ${String(error)}`);
      }
    }
    if (nodeCompileCacheRoot && baseEnv[NODE_COMPILE_CACHE_WRITER_ENV_KEY] === "1") {
      try {
        const pruned = pruneFsModuleCache(
          nodeCompileCacheRoot,
          options.nodeCompileCacheMaxBytes ?? NODE_COMPILE_CACHE_MAX_BYTES,
        );
        process.stdout.write(
          `[shard:cache] node-compile ${pruned.beforeBytes} -> ${pruned.afterBytes} bytes; removed ${pruned.removedFiles} files\n`,
        );
      } catch (error) {
        console.warn(`[shard:cache] failed to prune Node compile cache: ${String(error)}`);
      }
    }
    return exitCode;
  } finally {
    try {
      await context?.workerRun.dispose();
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (interrupted && context) {
        await context.exitBySignal(interrupted);
      }
    }
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const plans = resolveShardPlans();
  process.exitCode = await runShardPlans(plans, {
    continueOnFailure: process.env.OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE === "1",
  });
}
