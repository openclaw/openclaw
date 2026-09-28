#!/usr/bin/env node

// Run bounded test graphs in fresh processes so one shard's checker heap cannot
// accumulate while the next shard loads.
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { CoreTsgoGraph } from "./check-tsgo-core-boundary.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { resolveLocalCheckEnv } from "./lib/local-check-runtime.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  expandTsgoExecutionGraphs,
  TSGO_ROOT_TEST_SHARDS,
  selectTsgoCoreTestShards,
  selectChangedTsgoCoreTestShards,
  selectChangedCiTsgoGraphs,
  resolveChangedCiTsgoInputs,
  resolveCiTsgoGraphs,
  TSGO_CI_GRAPHS,
  TSGO_CORE_TEST_SHARDS,
  selectTsgoCoreTestStripe,
} from "./lib/tsgo-core-test-shards.mts";
import { prepareTsgoCommand, runPreparedTsgoCommand } from "./run-tsgo.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
async function runShard(config: string, env: NodeJS.ProcessEnv, evidenceId: string) {
  const command = prepareTsgoCommand(
    // These graphs have no project references. Project mode rechecks root
    // membership even when a restored build-info file is newer than a new root.
    [
      "-p",
      config,
      "--incremental",
      // The package command pins this config's cache at the repository root.
      ...(config === "test/tsconfig/tsconfig.test.root.json"
        ? ["--tsBuildInfoFile", ".artifacts/tsgo-cache/test-root.tsbuildinfo"]
        : []),
    ],
    env,
    repoRoot,
  );
  // One owner joins each native compiler. A second wrapper's escalation deadline
  // can kill the cleanup owner before it releases its artifact claim.
  let verified = false;
  const code = command
    ? await runPreparedTsgoCommand(command, {
        evidenceId,
        onEvidence: () => {
          verified = true;
        },
      })
    : 0;
  return { code, verified };
}

/** Runs selected canonical graphs under the same output and child-process owner. */
async function runTsgoCoreTestShards(
  shards: readonly { name: string; config: string }[],
  options: { concurrency?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const executionGraphs = expandTsgoExecutionGraphs(shards);
  // Root partitions bound one large checker heap. Concurrent partitions would
  // reconstruct that aggregate peak, including callers that request CI overlap.
  const isRootPartition = (graph: { config: string }) =>
    TSGO_ROOT_TEST_SHARDS.some((root) => root.config === graph.config);
  const hasRootPartitions = executionGraphs.some(isRootPartition);
  const concurrency = hasRootPartitions ? 1 : (options.concurrency ?? 1);
  const env = resolveLocalCheckEnv(options.env ?? process.env);
  const evidenceMode = env.OPENCLAW_CI_STATIC_EVIDENCE === "1" && process.platform !== "win32";
  const id = randomUUID();
  const leaves: string[] = [];
  // The batch owns outputs once; its existing compiler concurrency stays intact
  // without children waiting to reacquire their parent's lock.
  const resultCode = await withDistArtifactOwnership(repoRoot, async () => {
    const queue = executionGraphs.map((shard, index) => ({
      ...shard,
      evidenceId: `${id}:${index}`,
    }));
    let failureCode = 0;
    let stopped = false;
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (;;) {
        const shard = queue.shift();
        if (!shard || stopped) {
          return;
        }
        const startedAt = performance.now();
        const { code, verified } = await runShard(shard.config, env, shard.evidenceId).catch(
          (error: unknown) => {
            stopped = true;
            failureCode = 1;
            throw error;
          },
        );
        console.error(
          `[tsgo:${shard.name}] ${code === 0 ? "passed" : `failed (exit ${code})`} in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
        );
        if (code !== 0 && failureCode === 0) {
          failureCode = code;
        }
        if (verified) {
          leaves.push(shard.evidenceId);
        }
        // Only complete native diagnostics can justify draining a failed graph.
        if ((isRootPartition(shard) && code !== 0) || (evidenceMode ? !verified : code !== 0)) {
          stopped = true;
          failureCode ||= 1;
        }
      }
    });
    const results = await Promise.allSettled(workers);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "tsgo core test shards failed");
    }
    return failureCode;
  });
  if (evidenceMode && leaves.length === executionGraphs.length) {
    console.log(
      `[ci-static:tsgo:completion] ${JSON.stringify({ version: 1, id, planned: executionGraphs.length, completed: leaves.length, leaves })}`,
    );
  }
  return resultCode;
}

/** Owns one changed-check execution; plans never retain compiler inventories. */
export function createChangedCoreTestCheck(
  paths: readonly string[],
  env: NodeJS.ProcessEnv,
  stripeShards?: readonly { name: string; config: string }[],
) {
  const stripeConfigs = stripeShards && new Set(stripeShards.map((shard) => shard.config));
  let graphs: CoreTsgoGraph[] | undefined;
  return {
    async checkBoundary(): Promise<number> {
      graphs = undefined;
      const { checkCoreTsgoGraphBoundary, CoreTsgoBoundaryInterruptedError } =
        await import("./check-tsgo-core-boundary.mts");
      try {
        graphs = await checkCoreTsgoGraphBoundary();
        return 0;
      } catch (error) {
        if (error instanceof CoreTsgoBoundaryInterruptedError) {
          console.error(error.message);
          return error.exitCode;
        }
        throw error;
      }
    },
    async checkTypes(concurrency = 1): Promise<number> {
      const inspected = graphs;
      graphs = undefined;
      const shards = inspected && selectChangedTsgoCoreTestShards(paths, inspected);
      const candidates = shards ?? TSGO_CORE_TEST_SHARDS;
      const selected = stripeConfigs
        ? candidates.filter((shard) => stripeConfigs.has(shard.config))
        : candidates;
      console.error(
        `[check:changed] core test graphs: ${selected.map((shard) => shard.name).join(", ")}`,
      );
      return await runTsgoCoreTestShards(selected, { env, concurrency });
    },
  };
}

/** Preflight selects compiler consumers once; executing rows retain their existing owners. */
export async function createChangedCiTypeCheckPlan(
  paths: readonly string[],
  options: { cwd?: string } = {},
) {
  const cwd = realpathSync(options.cwd ?? repoRoot);
  if (!resolveChangedCiTsgoInputs(paths, (file) => existsSync(path.resolve(cwd, file)))) {
    return { mode: "full", graphs: TSGO_CI_GRAPHS };
  }
  const { inspectCiTsgoCheckGraphs } = await import("./check-tsgo-core-boundary.mts");
  const inspected = await inspectCiTsgoCheckGraphs({ cwd });
  const selected = paths.every((file) => existsSync(path.resolve(cwd, file)))
    ? selectChangedCiTsgoGraphs(paths, inspected)
    : undefined;
  return { mode: selected ? "changed" : "full", graphs: selected ?? TSGO_CI_GRAPHS };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  // Each graph is a serial single-project build, so tsgo gains little past four
  // cores; CI stripe jobs opt into overlapping fresh child processes to use the
  // idle cores. Local runs stay serial to keep the heap-bounded default.
  const concurrencyFlagIndex = process.argv.indexOf("--concurrency");
  let concurrency = 1;
  if (concurrencyFlagIndex >= 0) {
    const rawConcurrency = process.argv[concurrencyFlagIndex + 1] ?? "";
    concurrency = Number(rawConcurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
      console.error(`Invalid shard concurrency (expected 1-4): ${rawConcurrency}`);
      process.exit(1);
    }
  }

  // Stripe ownership is defined by the complete registry, before consumer narrowing.
  const stripeFlagIndex = process.argv.indexOf("--stripe");
  let stripeShards;
  if (stripeFlagIndex >= 0) {
    const stripeSpec = process.argv[stripeFlagIndex + 1] ?? "";
    stripeShards = selectTsgoCoreTestStripe(stripeSpec);
    if (!stripeShards) {
      console.error(`Invalid core test stripe (expected i/n or first-last/n): ${stripeSpec}`);
      process.exit(1);
    }
  }

  const ciGraphsIndex = process.argv.indexOf("--ci-graphs-json");
  const changedPathsIndex = process.argv.indexOf("--changed-paths-json");
  if (ciGraphsIndex >= 0) {
    const names: unknown = JSON.parse(process.argv[ciGraphsIndex + 1] ?? "null");
    if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) {
      throw new Error("--ci-graphs-json requires a JSON string array");
    }
    process.exitCode = await runTsgoCoreTestShards(resolveCiTsgoGraphs(names), { concurrency });
  } else if (changedPathsIndex >= 0) {
    const paths: unknown = JSON.parse(process.argv[changedPathsIndex + 1] ?? "null");
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      !paths.every((file) => typeof file === "string")
    ) {
      throw new Error("--changed-paths-json requires a nonempty JSON string array");
    }
    const check = createChangedCoreTestCheck(paths, process.env, stripeShards);
    process.exitCode = (await check.checkBoundary()) || (await check.checkTypes(concurrency));
  } else {
    // CI stripes split the serial shard sequence across parallel jobs; the
    // stripe union is exactly the full shard list, so coverage is unchanged.
    let shards = stripeShards;
    if (!shards) {
      const requestedGroup = process.argv[2];
      shards = selectTsgoCoreTestShards(requestedGroup);
      if (!shards) {
        console.error(`Unknown core test shard group: ${requestedGroup}`);
        process.exit(1);
      }
    }
    process.exitCode = await runTsgoCoreTestShards(shards, { concurrency });
  }
}
