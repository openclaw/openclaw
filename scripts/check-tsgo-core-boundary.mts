#!/usr/bin/env node

// Enforces core tsgo project boundaries and sparse-checkout safety.
import { realpathSync } from "node:fs";
import path from "node:path";
import { isCommandCancellation, runCancelableCommand } from "./lib/cancelable-command.mts";
import { reportLimitViolations } from "./lib/check-limits.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { writeFailedTrailer } from "./lib/failed-trailer.mts";
import { resolveRepoToolBinPath } from "./lib/local-check-runtime.mts";
import { signalExitCode } from "./lib/managed-child-process.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { runSemanticCheck } from "./lib/semantic-check-admission.mts";
import {
  findOversizedTsgoCoreTestShards,
  findTsgoCoreTestShardViolations,
  TSGO_CI_ADDITIONAL_GRAPHS,
  TSGO_CORE_GRAPHS,
  TSGO_CORE_TEST_SHARDS,
} from "./lib/tsgo-core-test-shards.mts";
const repoRoot = resolveRepoRoot(import.meta.url);
const tsgoPath = resolveRepoToolBinPath("tsgo", { cwd: repoRoot });
const canonicalCoreTestConfig = "test/tsconfig/tsconfig.core.test.json";

function normalizeFilePath(filePath: string, cwd: string) {
  const normalized = filePath.trim().replaceAll("\\", "/");
  const normalizedRoot = cwd.replaceAll("\\", "/");
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

export class CoreTsgoBoundaryInterruptedError extends Error {
  readonly exitCode: number;

  constructor(signal: NodeJS.Signals) {
    super(`Core tsgo graph boundary interrupted by ${signal}`);
    this.exitCode = signalExitCode(signal);
  }
}

async function runTsgoQuery(
  config: string,
  query: string,
  label: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const outputs: Buffer[][] = [[], []];
  const overflow = new AbortController();
  let outputBytes = 0;
  let code: number;
  try {
    code = await runSemanticCheck({
      bin: tsgoPath,
      args: ["-p", config, "--pretty", "false", query],
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.any([signal, overflow.signal]),
      requireProcessTreeExit: process.platform !== "win32",
      onReady(child) {
        for (const [index, stream] of [child.stdout!, child.stderr!].entries()) {
          stream.on("data", (chunk: Buffer) => {
            if (overflow.signal.aborted) {
              return;
            }
            outputBytes += chunk.byteLength;
            // Inventory must be complete; preserve the existing bound and fail rather than truncate.
            if (outputBytes > 256 * 1024 * 1024) {
              overflow.abort();
              return;
            }
            outputs[index]!.push(chunk);
          });
        }
      },
    });
  } catch (error) {
    // Never hide an unjoined tree or filesystem failure behind cancellation.
    if (!isCommandCancellation(error)) {
      throw error;
    }
    if (overflow.signal.aborted) {
      throw new Error(`${label} output exceeded 256 MiB`, { cause: error });
    }
    throw error;
  }
  signal.throwIfAborted();
  const [stdout, stderr] = outputs.map((chunks) => Buffer.concat(chunks).toString("utf8"));
  if (code !== 0) {
    throw new Error(
      `${label} failed with exit code ${code}\n${[stdout, stderr].filter(Boolean).join("\n")}`,
    );
  }
  return stdout!;
}

async function readGraphConfig(
  config: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{
  compilerOptions?: { tsBuildInfoFile?: string };
  files?: string[];
}> {
  return JSON.parse(
    await runTsgoQuery(config, "--showConfig", `${config} config expansion`, cwd, signal),
  ) as {
    compilerOptions?: { tsBuildInfoFile?: string };
    files?: string[];
  };
}

export type CoreTsgoGraph = {
  name: string;
  config: string;
  roots: readonly string[];
  files: readonly string[];
};

async function withBoundaryCancellation(
  run: (signal: AbortSignal) => Promise<CoreTsgoGraph[]>,
): Promise<CoreTsgoGraph[]> {
  let graphs: CoreTsgoGraph[] | undefined;
  let received: NodeJS.Signals | undefined;
  // Own the whole discovery lifetime, including admission and gaps between queries.
  await runCancelableCommand(
    async (signal) => {
      graphs = await run(signal);
      return 0;
    },
    {
      onSignal: (signal) => {
        received = signal;
      },
    },
  );
  if (received) {
    throw new CoreTsgoBoundaryInterruptedError(received);
  }
  return graphs!;
}

/** Validates all boundaries and returns this invocation's compiler-resolved inputs. */
export async function checkCoreTsgoGraphBoundary(
  options: { cwd?: string } = {},
): Promise<CoreTsgoGraph[]> {
  const cwd = realpathSync(options.cwd ?? repoRoot);
  return await withBoundaryCancellation((signal) => readCoreTsgoGraphBoundary(cwd, signal));
}

async function readCoreTsgoGraphBoundary(
  cwd: string,
  signal: AbortSignal,
): Promise<CoreTsgoGraph[]> {
  const normalize = (file: string) => normalizeFilePath(file, cwd);
  const testRootPattern = /\.test\.(?:ts|tsx)$/u;
  const canonicalRoots = ((await readGraphConfig(canonicalCoreTestConfig, cwd, signal)).files ?? [])
    .map(normalize)
    .filter((file) => testRootPattern.test(file));
  const shardConfigs = [];
  for (const shard of TSGO_CORE_TEST_SHARDS) {
    shardConfigs.push({ ...shard, expanded: await readGraphConfig(shard.config, cwd, signal) });
  }
  const shardRoots = shardConfigs.map((shard) => ({
    name: shard.name,
    roots: (shard.expanded.files ?? []).map(normalize).filter((file) => testRootPattern.test(file)),
  }));
  const oversized = reportLimitViolations(
    findOversizedTsgoCoreTestShards({ shards: shardRoots }).map((message) => ({
      file: canonicalCoreTestConfig,
      title: "Core test shard root budget",
      message,
    })),
  );
  const shardViolations = findTsgoCoreTestShardViolations({
    canonicalRoots,
    shards: shardRoots,
  });

  const buildInfoOwners = new Map<string, string[]>();
  for (const shard of shardConfigs) {
    const buildInfo = shard.expanded.compilerOptions?.tsBuildInfoFile;
    if (!buildInfo) {
      shardViolations.push(`${shard.name}: missing compilerOptions.tsBuildInfoFile`);
      continue;
    }
    const owners = buildInfoOwners.get(buildInfo) ?? [];
    owners.push(shard.name);
    buildInfoOwners.set(buildInfo, owners);
  }
  for (const [buildInfo, owners] of buildInfoOwners) {
    if (owners.length > 1) {
      shardViolations.push(`shared tsBuildInfoFile (${owners.join(", ")}): ${buildInfo}`);
    }
  }

  if (shardViolations.length > 0) {
    console.error("Core test shards must cover every canonical test root exactly once:");
    for (const violation of shardViolations) {
      console.error(`- ${violation}`);
    }
    throw new Error("Core test graph ownership validation failed");
  }
  if (oversized) {
    throw new Error("Core test shard root budget exceeded");
  }

  const violations: string[] = [];
  const graphs: CoreTsgoGraph[] = [];
  for (const graph of TSGO_CORE_GRAPHS) {
    const files = (
      await runTsgoQuery(graph.config, "--listFilesOnly", `${graph.name} file listing`, cwd, signal)
    )
      .split(/\r?\n/u)
      .map(normalize)
      .filter(Boolean);
    graphs.push({
      ...graph,
      files,
      roots: (shardConfigs.find((shard) => shard.config === graph.config)?.expanded.files ?? [])
        .map((file) => normalize(path.resolve(cwd, path.dirname(graph.config), file)))
        .filter((file) => testRootPattern.test(file)),
    });
    const extensionFiles = files.filter((file) => file.startsWith("extensions/"));
    for (const file of extensionFiles) {
      violations.push(`${graph.name}: ${file}`);
    }
  }

  if (violations.length > 0) {
    console.error("Core tsgo graphs must not include bundled extension files:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    console.error(
      "Move extension-owned behavior behind plugin SDK contracts, public artifacts, or extension-local tests.",
    );
    throw new Error("Core tsgo graphs include bundled extension files");
  }
  return graphs;
}

/** Reuse the core boundary admission before inspecting the remaining CI compilers. */
export async function inspectCiTsgoCheckGraphs(
  options: { cwd?: string } = {},
): Promise<CoreTsgoGraph[]> {
  const cwd = realpathSync(options.cwd ?? repoRoot);
  return await withBoundaryCancellation(async (signal) => {
    const graphs = await readCoreTsgoGraphBoundary(cwd, signal);
    for (const graph of TSGO_CI_ADDITIONAL_GRAPHS) {
      const files = (
        await runTsgoQuery(
          graph.config,
          "--listFilesOnly",
          `${graph.name} file listing`,
          cwd,
          signal,
        )
      )
        .split(/\r?\n/u)
        .map((file) => normalizeFilePath(file, cwd))
        .filter(Boolean);
      graphs.push({ ...graph, files, roots: [] });
    }
    return graphs;
  });
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    await checkCoreTsgoGraphBoundary();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CoreTsgoBoundaryInterruptedError ? error.exitCode : 1;
    writeFailedTrailer("tsgo-boundary", process.exitCode);
  }
}
