#!/usr/bin/env node

// Profiles selected tsgo graphs and writes diagnostics/trace artifacts for
// TypeScript graph size and performance investigations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCommandCancellation, runCancelableCommand } from "./lib/cancelable-command.mts";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { applyLocalTsgoPolicy, resolveRepoToolBinPath } from "./lib/local-check-runtime.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { runSemanticCheck } from "./lib/semantic-check-admission.mts";
import { TSGO_CORE_TEST_SHARDS, type TsgoCoreTestShard } from "./lib/tsgo-core-test-shards.mts";
const repoRoot = resolveRepoRoot(import.meta.url);
const artifactRoot = path.resolve(repoRoot, ".artifacts/tsgo-profile");
const tsgoPath = resolveRepoToolBinPath("tsgo", { cwd: repoRoot });

type GraphDefinition = { config: string; description: string };
type CoreTestGraphName = `core-test-${TsgoCoreTestShard["name"]}`;
const CORE_TEST_GRAPH_DEFINITIONS = Object.fromEntries(
  TSGO_CORE_TEST_SHARDS.map((shard) => [
    `core-test-${shard.name}`,
    {
      config: shard.config,
      description: `bounded core test shard: ${shard.name}`,
    },
  ]),
) as Record<CoreTestGraphName, GraphDefinition>;

const GRAPH_DEFINITIONS = {
  core: {
    config: "tsconfig.core.json",
    description: "core production graph",
  },
  ui: {
    config: "tsconfig.ui.json",
    description: "UI production graph",
  },
  ...CORE_TEST_GRAPH_DEFINITIONS,
  extensions: {
    config: "tsconfig.extensions.json",
    description: "bundled extension production graph",
  },
  "extensions-test": {
    config: "test/tsconfig/tsconfig.extensions.test.json",
    description: "bundled extension colocated test graph",
  },
} as const;

type GraphName = keyof typeof GRAPH_DEFINITIONS;
const DEFAULT_GRAPHS = [
  ...TSGO_CORE_TEST_SHARDS.map((shard) => `core-test-${shard.name}` as CoreTestGraphName),
  "extensions-test",
] satisfies GraphName[];
type ProfileOptions = {
  all: boolean;
  deep: boolean;
  explain: boolean;
  json: boolean;
  reuse: boolean;
  outDir: string;
};
type Diagnostics = Record<string, number>;
type ProfileGraphResult = Awaited<ReturnType<typeof profileGraph>>;
type ProfileReport = {
  generatedAt: string;
  options: { graphs: GraphName[]; deep: boolean; explain: boolean; reuse: boolean };
  graphs: ProfileGraphResult[];
  paths: { json?: string; text?: string };
};

function usage(): string {
  return [
    "Usage: pnpm tsgo:profile [graph...] [options]",
    "",
    "Graphs:",
    ...Object.entries(GRAPH_DEFINITIONS).map(
      ([name, graph]) => `  ${name.padEnd(26)} ${graph.description}`,
    ),
    "",
    "Options:",
    "  --all              Profile all graphs",
    "  --reuse            Reuse profile tsbuildinfo files instead of forcing fresh checks",
    "  --deep             Also write --generateTrace and --pprofDir artifacts",
    "  --explain          Also write list-only --explainFiles artifacts",
    "  --out=<dir>        Output directory (default: .artifacts/tsgo-profile)",
    "  --json             Print JSON report to stdout",
    "  --help             Show this help",
    "",
    "Default graphs: all bounded core-test shards and extensions-test",
  ].join("\n");
}

function parseArgs(argv: string[]): { options: ProfileOptions; selectedGraphs: GraphName[] } {
  const graphNames: GraphName[] = [];
  const options: ProfileOptions = {
    all: false,
    deep: false,
    explain: false,
    json: false,
    reuse: false,
    outDir: artifactRoot,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--deep") {
      options.deep = true;
      continue;
    }
    if (arg === "--explain") {
      options.explain = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--reuse") {
      options.reuse = true;
      continue;
    }
    if (arg.startsWith("--out=")) {
      options.outDir = path.resolve(repoRoot, arg.slice("--out=".length));
      continue;
    }
    if (!(arg in GRAPH_DEFINITIONS)) {
      throw new Error(`Unknown graph: ${arg}\n\n${usage()}`);
    }
    graphNames.push(arg as GraphName);
  }

  const selectedGraphs = options.all
    ? (Object.keys(GRAPH_DEFINITIONS) as GraphName[])
    : graphNames.length > 0
      ? graphNames
      : DEFAULT_GRAPHS;

  return { options, selectedGraphs };
}

function ensureDirs(outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "cache"), { recursive: true });
}

function removeIfFreshMode(filePath: string, reuse: boolean): void {
  if (!reuse) {
    fs.rmSync(filePath, { force: true });
  }
}

async function runTsgo(
  label: string,
  args: string[],
  signal: AbortSignal,
  artifactOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<{ elapsedMs: number; stdout: string; stderr: string }> {
  const { args: finalArgs, env } = applyLocalTsgoPolicy(args, process.env, {
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  });
  const startedAt = Date.now();
  const outputAbort = new AbortController();
  // Artifact phases retain the previous per-stream 256 MiB ceiling on disk.
  // Supervisor captures stay small outside the compiler's memory scope.
  const maxBytes = (artifactOutput ? 256 : 16) * 1024 * 1024;
  const outputBytes = { stdout: 0, stderr: 0 };
  let outputFailure: Error | undefined;
  let capturing = true;
  let stdout = "";
  let stderr = "";
  let status: number;
  try {
    status = await runSemanticCheck({
      bin: tsgoPath,
      args: finalArgs,
      cwd: repoRoot,
      env,
      signal: AbortSignal.any([signal, outputAbort.signal]),
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        for (const [name, stream] of [
          ["stdout", child.stdout!],
          ["stderr", child.stderr!],
        ] as const) {
          stream.setEncoding("utf8");
          stream.on("data", (chunk: string) => {
            if (!capturing || outputAbort.signal.aborted) {
              return;
            }
            outputBytes[name] += Buffer.byteLength(chunk);
            const bytes = artifactOutput
              ? outputBytes[name]
              : outputBytes.stdout + outputBytes.stderr;
            try {
              if (bytes > maxBytes) {
                throw new Error(`${label} exceeded its ${maxBytes}-byte output limit`);
              }
              // Synchronous chunk writes apply backpressure without accumulating
              // pending writes. Artifact phases keep only a diagnostic tail in RAM.
              artifactOutput?.(name, chunk);
              if (name === "stdout") {
                stdout = artifactOutput ? (stdout + chunk).slice(-65536) : stdout + chunk;
              } else {
                stderr = artifactOutput ? (stderr + chunk).slice(-65536) : stderr + chunk;
              }
            } catch (error) {
              outputFailure = error instanceof Error ? error : new Error(String(error));
              outputAbort.abort();
            }
          });
        }
      },
    });
  } catch (error) {
    // Overflow is reported only after joined cancellation; cleanup uncertainty
    // must retain its identity for the surrounding artifact owner.
    if (outputFailure && isCommandCancellation(error)) {
      throw new Error(outputFailure.message, { cause: error });
    }
    throw error;
  } finally {
    capturing = false;
  }
  signal.throwIfAborted();
  if (outputFailure) {
    throw outputFailure;
  }
  const elapsedMs = Date.now() - startedAt;
  if (status !== 0) {
    const output = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`${label} failed with exit code ${status}\n${output}`);
  }
  return { elapsedMs, stdout, stderr };
}

/** Preserve stdout-then-stderr artifact ordering without retaining either body. */
async function runArtifactPhase(
  label: string,
  args: string[],
  signal: AbortSignal,
  artifact: string,
  includeStderr = false,
) {
  const stderrArtifact = artifact + ".stderr";
  const stdoutFd = fs.openSync(artifact, "w");
  let stderrFd: number | undefined;
  let completed: { elapsedMs: number } | undefined;
  const failures: unknown[] = [];
  try {
    stderrFd = fs.openSync(stderrArtifact, "w");
    const result = await runTsgo(label, args, signal, (stream, chunk) => {
      fs.writeFileSync(stream === "stdout" ? stdoutFd : stderrFd!, Buffer.from(chunk));
    });
    if (includeStderr) {
      for await (const chunk of fs.createReadStream(stderrArtifact)) {
        signal.throwIfAborted();
        fs.writeFileSync(stdoutFd, chunk as Buffer);
      }
    }
    completed = { elapsedMs: result.elapsedMs };
  } catch (error) {
    failures.push(error);
  } finally {
    // Preserve uncertain child ownership through cleanup failures, and attempt
    // both closes even when the first fails. Artifact ownership reads this chain.
    for (const fd of [stdoutFd, stderrFd]) {
      if (fd === undefined) {
        continue;
      }
      try {
        fs.closeSync(fd);
      } catch (error) {
        failures.push(error);
      }
    }
    if (completed && failures.length === 0) {
      try {
        fs.rmSync(stderrArtifact);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Profiler artifact cleanup failed");
  }
  return completed!;
}

function parseDiagnostics(output: string): Diagnostics {
  const diagnostics: Diagnostics = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(.+?):\s+([0-9.]+)(K|s)?\s*$/u.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, rawKey, rawValue, unit] = match;
    const key = rawKey!.trim().replaceAll(/\s+/gu, " ");
    const value = Number(rawValue);
    diagnostics[key] = unit === "K" ? value * 1024 : value;
  }
  return diagnostics;
}

function normalizeFilePath(filePath: string): string {
  const normalized = filePath.trim().replaceAll("\\", "/");
  const normalizedRoot = repoRoot.replaceAll("\\", "/");
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

function packageNameFromNodeModule(parts: string[], startIndex: number): string {
  const first = parts[startIndex + 1];
  if (!first) {
    return "node_modules";
  }
  if (first.startsWith("@")) {
    return `${first}/${parts[startIndex + 2] ?? ""}`.replace(/\/$/u, "");
  }
  return first;
}

function classifyFile(relativePath: string): string {
  const parts = relativePath.split("/");
  const first = parts[0];
  if (relativePath.includes("/node_modules/") || first === "node_modules") {
    const nodeModulesIndex = parts.indexOf("node_modules");
    return `node_modules/${packageNameFromNodeModule(parts, nodeModulesIndex)}`;
  }
  if (first && ["extensions", "packages", "src", "ui", "test"].includes(first)) {
    return `${first}/${parts[1] ?? "(root)"}`;
  }
  if (first?.startsWith("/") || (first !== undefined && /^[A-Za-z]:/u.test(first))) {
    return "(external)";
  }
  return first || "(unknown)";
}

async function summarizeFiles(artifact: string) {
  const counts = new Map<string, number>();
  let totalFiles = 0;
  let projectRelativeFiles = 0;
  let testFiles = 0;
  // The inventory stays on disk; retain only group counts and one input line.
  const recordFile = (line: string) => {
    const file = normalizeFilePath(line);
    if (!file || file.startsWith("Files:")) {
      return;
    }
    totalFiles++;
    if (path.isAbsolute(file) || /^[A-Za-z]:/u.test(file)) {
      return;
    }
    projectRelativeFiles++;
    if (/\.test\.[cm]?[tj]sx?$/u.test(file)) {
      testFiles++;
    }
    const key = classifyFile(file);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  let pending = "";
  for await (const chunk of fs.createReadStream(artifact, { encoding: "utf8" })) {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      recordFile(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  }
  if (pending) {
    recordFile(pending);
  }
  return {
    totalFiles,
    projectRelativeFiles,
    testFiles,
    groups: [...counts.entries()]
      .map(([key, count]) => ({ key, count }))
      .toSorted((left, right) => right.count - left.count || left.key.localeCompare(right.key))
      .slice(0, 40),
  };
}

function summarizeDiagnostics(result: Awaited<ReturnType<typeof runTsgo>>) {
  return {
    elapsedMs: result.elapsedMs,
    diagnostics: parseDiagnostics(`${result.stdout}\n${result.stderr}`),
  };
}

function diffDiagnostics(check: Diagnostics, noCheck: Diagnostics) {
  const totalDelta = (check["Total time"] ?? 0) - (noCheck["Total time"] ?? 0);
  const checkTime = check["Check time"] ?? 0;
  return {
    checkTimeSeconds: checkTime,
    totalDeltaSeconds: totalDelta,
    typeShareOfTotal:
      check["Total time"] && checkTime ? Number((checkTime / check["Total time"]).toFixed(3)) : 0,
  };
}

function formatSeconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

function renderTextReport(report: ProfileReport): string {
  const lines = [
    "# tsgo profile",
    "",
    `Generated: ${report.generatedAt}`,
    `Fresh profile caches: ${report.options.reuse ? "no" : "yes"}`,
    "",
  ];

  for (const graph of report.graphs) {
    const check = graph.check.diagnostics;
    const noCheck = graph.noCheck.diagnostics;
    lines.push(`## ${graph.name}`);
    lines.push(`Config: ${graph.config}`);
    lines.push(
      `Check: wall ${formatSeconds(graph.check.elapsedMs / 1000)}, compiler total ${formatSeconds(
        check["Total time"] ?? 0,
      )}, check ${formatSeconds(check["Check time"] ?? 0)}, memory ${Math.round(
        (check["Memory used"] ?? 0) / 1024 / 1024,
      )} MiB`,
    );
    lines.push(
      `NoCheck: wall ${formatSeconds(
        graph.noCheck.elapsedMs / 1000,
      )}, compiler total ${formatSeconds(noCheck["Total time"] ?? 0)}`,
    );
    lines.push(
      `Files: compiler ${check.Files ?? "?"}, listed ${graph.files.totalFiles}, project-relative ${graph.files.projectRelativeFiles}, tests ${graph.files.testFiles}`,
    );
    lines.push(`File list: ${graph.files.artifact}`);
    lines.push(
      `Type cost: check ${formatSeconds(graph.typeCost.checkTimeSeconds)}, total delta ${formatSeconds(
        graph.typeCost.totalDeltaSeconds,
      )}, share ${(graph.typeCost.typeShareOfTotal * 100).toFixed(1)}%`,
    );
    lines.push("Top file groups:");
    for (const group of graph.files.groups.slice(0, 15)) {
      lines.push(`- ${group.key}: ${group.count}`);
    }
    if (graph.deep) {
      lines.push(`Deep artifacts: ${graph.deep.traceDir}, ${graph.deep.profileDir}`);
    }
    if (graph.explain) {
      lines.push(`Explain: ${graph.explain.artifact}`);
    }
    lines.push("");
  }

  lines.push(`JSON: ${report.paths.json ?? ""}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function profileGraph(name: GraphName, options: ProfileOptions, signal: AbortSignal) {
  const graph = GRAPH_DEFINITIONS[name];
  const outDir = options.outDir;
  const graphCacheRoot = path.join(outDir, "cache");
  const checkBuildInfo = path.join(graphCacheRoot, `${name}-check.tsbuildinfo`);
  const noCheckBuildInfo = path.join(graphCacheRoot, `${name}-nocheck.tsbuildinfo`);
  const configPath = graph.config;

  removeIfFreshMode(checkBuildInfo, options.reuse);
  removeIfFreshMode(noCheckBuildInfo, options.reuse);

  const baseArgs = ["-p", configPath, "--pretty", "false"];
  const filesArtifact = path.join(outDir, `${name}.files.txt`);
  // Retain summaries only before starting the next admitted compiler phase.
  await runArtifactPhase(
    `${name}:listFilesOnly`,
    [...baseArgs, "--listFilesOnly"],
    signal,
    filesArtifact,
  );
  const files = {
    ...(await summarizeFiles(filesArtifact)),
    artifact: path.relative(repoRoot, filesArtifact),
  };
  const noCheck = await runTsgo(
    `${name}:noCheck`,
    [
      ...baseArgs,
      "--noCheck",
      "--incremental",
      "--tsBuildInfoFile",
      noCheckBuildInfo,
      "--extendedDiagnostics",
    ],
    signal,
  ).then(summarizeDiagnostics);

  const checkArgs = [
    ...baseArgs,
    "--incremental",
    "--tsBuildInfoFile",
    checkBuildInfo,
    "--extendedDiagnostics",
  ];
  let deep: { profileDir: string; traceDir: string } | undefined;
  if (options.deep) {
    const traceDir = path.join(outDir, `${name}-trace`);
    const profileDir = path.join(outDir, `${name}-pprof`);
    fs.rmSync(traceDir, { force: true, recursive: true });
    fs.rmSync(profileDir, { force: true, recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    checkArgs.push("--generateTrace", traceDir, "--pprofDir", profileDir);
    deep = {
      traceDir: path.relative(repoRoot, traceDir),
      profileDir: path.relative(repoRoot, profileDir),
    };
  }
  const check = await runTsgo(`${name}:check`, checkArgs, signal).then(summarizeDiagnostics);
  let explain: { artifact: string; elapsedMs: number } | undefined;
  if (options.explain) {
    const explainArtifact = path.join(outDir, `${name}.explain.txt`);
    const explainResult = await runArtifactPhase(
      `${name}:explainFiles`,
      [...baseArgs, "--listFilesOnly", "--explainFiles"],
      signal,
      explainArtifact,
      true,
    );
    explain = {
      artifact: path.relative(repoRoot, explainArtifact),
      elapsedMs: explainResult.elapsedMs,
    };
  }

  return {
    name,
    config: configPath,
    description: graph.description,
    files,
    noCheck,
    check,
    typeCost: diffDiagnostics(check.diagnostics, noCheck.diagnostics),
    ...(deep ? { deep } : {}),
    ...(explain ? { explain } : {}),
  };
}

async function writeProfileReport(
  { options, selectedGraphs }: ReturnType<typeof parseArgs>,
  signal: AbortSignal,
): Promise<void> {
  ensureDirs(options.outDir);
  const report: ProfileReport = {
    generatedAt: new Date().toISOString(),
    options: {
      graphs: selectedGraphs,
      deep: options.deep,
      explain: options.explain,
      reuse: options.reuse,
    },
    graphs: [],
    paths: {},
  };

  for (const graphName of selectedGraphs) {
    process.stderr.write(`[tsgo-profile] profiling ${graphName}\n`);
    report.graphs.push(await profileGraph(graphName, options, signal));
  }

  signal.throwIfAborted();
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replace("T", "-")
    .replace("Z", "");
  const jsonPath = path.join(options.outDir, `tsgo-profile-${timestamp}.json`);
  const textPath = path.join(options.outDir, `tsgo-profile-${timestamp}.md`);
  report.paths = {
    json: path.relative(repoRoot, jsonPath),
    text: path.relative(repoRoot, textPath),
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  const text = renderTextReport(report);
  fs.writeFileSync(jsonPath, json);
  fs.writeFileSync(textPath, text);
  fs.writeFileSync(path.join(options.outDir, "latest.json"), json);
  fs.writeFileSync(path.join(options.outDir, "latest.md"), text);
  process.stdout.write(options.json ? json : text);
}

await runWithFailedTrailer("tsgo-profile", async () => {
  const parsed = parseArgs(process.argv.slice(2));
  process.exitCode = await runCancelableCommand((signal) =>
    withDistArtifactOwnership(
      repoRoot,
      async () => {
        await writeProfileReport(parsed, signal);
        return 0;
      },
      signal,
    ),
  );
});
