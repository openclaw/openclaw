import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  booleanFlag,
  floatFlag,
  intFlag,
  parseFlagArgs,
  readEnvNumber,
  stringFlag,
} from "./lib/arg-utils.mjs";
import { formatMs } from "./lib/vitest-report-cli-utils.mjs";
import { loadTestRunnerBehavior, loadUnitTimingManifest } from "./test-runner-manifest.mjs";

export function parseArgs(argv) {
  const envLimit = readEnvNumber("OPENCLAW_TEST_THREAD_CANDIDATE_LIMIT");
  return parseFlagArgs(
    argv,
    {
      config: "vitest.unit.config.ts",
      limit: Number.isFinite(envLimit) ? Math.max(1, Math.floor(envLimit)) : 20,
      minDurationMs: readEnvNumber("OPENCLAW_TEST_THREAD_CANDIDATE_MIN_DURATION_MS") ?? 250,
      minGainMs: readEnvNumber("OPENCLAW_TEST_THREAD_CANDIDATE_MIN_GAIN_MS") ?? 100,
      minGainPct: readEnvNumber("OPENCLAW_TEST_THREAD_CANDIDATE_MIN_GAIN_PCT") ?? 10,
      json: false,
      files: [],
    },
    [
      stringFlag("--config", "config"),
      intFlag("--limit", "limit", { min: 1 }),
      floatFlag("--min-duration-ms", "minDurationMs", { min: 0 }),
      floatFlag("--min-gain-ms", "minGainMs", { min: 0 }),
      floatFlag("--min-gain-pct", "minGainPct", { min: 0, includeMin: false }),
      booleanFlag("--json", "json"),
    ],
    {
      ignoreDoubleDash: true,
      onUnhandledArg(arg, args) {
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        args.files.push(arg);
        return "handled";
      },
    },
  );
}

export function getExistingThreadCandidateExclusions(behavior) {
  return new Set([
    ...(behavior.base?.threadPinned ?? []).map((entry) => entry.file),
    ...(behavior.base?.threadSingleton ?? []).map((entry) => entry.file),
    ...(behavior.unit?.isolated ?? []).map((entry) => entry.file),
    ...(behavior.unit?.threadPinned ?? []).map((entry) => entry.file),
    ...(behavior.unit?.threadSingleton ?? []).map((entry) => entry.file),
  ]);
}

export function selectThreadCandidateFiles({
  files,
  timings,
  exclude = new Set(),
  limit,
  minDurationMs,
  includeUnknownDuration = false,
}) {
  return files
    .map((file) => ({
      file,
      durationMs: timings.files[file]?.durationMs ?? null,
    }))
    .filter((entry) => !exclude.has(entry.file))
    .filter((entry) =>
      entry.durationMs === null ? includeUnknownDuration : entry.durationMs >= minDurationMs,
    )
    .toSorted((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit)
    .map((entry) => entry.file);
}

export function summarizeThreadBenchmark({ file, forks, threads, minGainMs, minGainPct }) {
  const forkOk = forks.exitCode === 0;
  const threadOk = threads.exitCode === 0;
  const gainMs = forks.elapsedMs - threads.elapsedMs;
  const gainPct = forks.elapsedMs > 0 ? (gainMs / forks.elapsedMs) * 100 : 0;
  const recommended =
    forkOk &&
    threadOk &&
    gainMs >= minGainMs &&
    gainPct >= minGainPct &&
    threads.elapsedMs < forks.elapsedMs;
  return {
    file,
    forks,
    threads,
    gainMs,
    gainPct,
    recommended,
  };
}

function benchmarkFile({ config, file, pool }) {
  const startedAt = process.hrtime.bigint();
  const run = spawnSync("pnpm", ["vitest", "run", "--config", config, `--pool=${pool}`, file], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  return {
    pool,
    exitCode: run.status ?? 1,
    elapsedMs,
    stderr: run.stderr ?? "",
    stdout: run.stdout ?? "",
  };
}

function buildOutput(results) {
  return results.map((result) => ({
    file: result.file,
    forksMs: Math.round(result.forks.elapsedMs),
    threadsMs: Math.round(result.threads.elapsedMs),
    gainMs: Math.round(result.gainMs),
    gainPct: Number(result.gainPct.toFixed(1)),
    forksExitCode: result.forks.exitCode,
    threadsExitCode: result.threads.exitCode,
    recommended: result.recommended,
  }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const behavior = loadTestRunnerBehavior();
  const timings = loadUnitTimingManifest();
  const exclude = getExistingThreadCandidateExclusions(behavior);
  const inputFiles = opts.files.length > 0 ? opts.files : Object.keys(timings.files);
  const candidates = selectThreadCandidateFiles({
    files: inputFiles,
    timings,
    exclude,
    limit: opts.limit,
    minDurationMs: opts.minDurationMs,
    includeUnknownDuration: opts.files.length > 0,
  });

  const results = [];
  for (const file of candidates) {
    const forks = benchmarkFile({ config: opts.config, file, pool: "forks" });
    const threads = benchmarkFile({ config: opts.config, file, pool: "threads" });
    results.push(
      summarizeThreadBenchmark({
        file,
        forks,
        threads,
        minGainMs: opts.minGainMs,
        minGainPct: opts.minGainPct,
      }),
    );
  }

  if (opts.json) {
    console.log(JSON.stringify(buildOutput(results), null, 2));
    return;
  }

  console.log(
    `[test-find-thread-candidates] tested=${String(results.length)} minGain=${formatMs(
      opts.minGainMs,
      0,
    )} minGainPct=${String(opts.minGainPct)}%`,
  );
  for (const result of results) {
    const status = result.recommended
      ? "recommend"
      : result.forks.exitCode !== 0
        ? "forks-failed"
        : result.threads.exitCode !== 0
          ? "threads-failed"
          : "skip";
    console.log(
      `${status.padEnd(14, " ")} ${result.file} forks=${formatMs(
        result.forks.elapsedMs,
        0,
      )} threads=${formatMs(result.threads.elapsedMs, 0)} gain=${formatMs(result.gainMs, 0)} (${result.gainPct.toFixed(1)}%)`,
    );
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
