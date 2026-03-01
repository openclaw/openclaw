import { spawnSync } from "node:child_process";

type CommandCase = {
  name: string;
  args: string[];
};

type Sample = {
  ms: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type CaseSummary = ReturnType<typeof summarize>;

const DEFAULT_RUNS = 8;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ENTRY = "dist/entry.js";

const DEFAULT_CASES: CommandCase[] = [
  { name: "--version", args: ["--version"] },
  { name: "--help", args: ["--help"] },
  { name: "health --json", args: ["health", "--json"] },
  { name: "status --json", args: ["status", "--json"] },
  { name: "status", args: ["status"] },
];

function parseFlagValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return process.argv[idx + 1];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function runCase(params: {
  entry: string;
  runCase: CommandCase;
  runs: number;
  timeoutMs: number;
}): Sample[] {
  const results: Sample[] = [];
  for (let i = 0; i < params.runs; i += 1) {
    const started = process.hrtime.bigint();
    const proc = spawnSync(process.execPath, [params.entry, ...params.runCase.args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_HIDE_BANNER: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      timeout: params.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    results.push({
      ms,
      exitCode: proc.status,
      signal: proc.signal,
    });
  }
  return results;
}

function summarize(samples: Sample[]) {
  const values = samples.map((entry) => entry.ms);
  const total = values.reduce((sum, value) => sum + value, 0);
  const avg = values.length > 0 ? total / values.length : 0;
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  return {
    avg,
    p50: median(values),
    p95: percentile(values, 95),
    min,
    max,
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function collectExitSummary(samples: Sample[]): string {
  const buckets = new Map<string, number>();
  for (const sample of samples) {
    const key =
      sample.signal != null
        ? `signal:${sample.signal}`
        : `code:${sample.exitCode == null ? "null" : String(sample.exitCode)}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([key, count]) => `${key}x${count}`).join(", ");
}

function printSuite(params: {
  title: string;
  entry: string;
  runs: number;
  timeoutMs: number;
}): Map<string, CaseSummary> {
  console.log(params.title);
  console.log(`Entry: ${params.entry}`);
  const suite = new Map<string, CaseSummary>();
  for (const commandCase of DEFAULT_CASES) {
    const samples = runCase({
      entry: params.entry,
      runCase: commandCase,
      runs: params.runs,
      timeoutMs: params.timeoutMs,
    });
    const stats = summarize(samples);
    const exitSummary = collectExitSummary(samples);
    suite.set(commandCase.name, stats);
    console.log(
      `${commandCase.name.padEnd(13)} avg=${formatMs(stats.avg)} p50=${formatMs(stats.p50)} p95=${formatMs(stats.p95)} min=${formatMs(stats.min)} max=${formatMs(stats.max)} exits=[${exitSummary}]`,
    );
  }
  console.log("");
  return suite;
}

async function main(): Promise<void> {
  const entryPrimary =
    parseFlagValue("--entry-primary") ?? parseFlagValue("--entry") ?? DEFAULT_ENTRY;
  const entrySecondary = parseFlagValue("--entry-secondary");
  const runs = parsePositiveInt(parseFlagValue("--runs"), DEFAULT_RUNS);
  const timeoutMs = parsePositiveInt(parseFlagValue("--timeout-ms"), DEFAULT_TIMEOUT_MS);

  console.log(`Node: ${process.version}`);
  console.log(`Runs per command: ${runs}`);
  console.log(`Timeout: ${timeoutMs}ms`);
  console.log("");

  const primaryResults = printSuite({
    title: "Primary entry",
    entry: entryPrimary,
    runs,
    timeoutMs,
  });

  if (entrySecondary) {
    const secondaryResults = printSuite({
      title: "Secondary entry",
      entry: entrySecondary,
      runs,
      timeoutMs,
    });

    console.log("Delta (secondary - primary, avg)");
    for (const commandCase of DEFAULT_CASES) {
      const primary = primaryResults.get(commandCase.name);
      const secondary = secondaryResults.get(commandCase.name);
      if (!primary || !secondary) {
        continue;
      }
      const delta = secondary.avg - primary.avg;
      const pct = primary.avg > 0 ? (delta / primary.avg) * 100 : 0;
      const sign = delta > 0 ? "+" : "";
      console.log(
        `${commandCase.name.padEnd(13)} ${sign}${formatMs(delta)} (${sign}${pct.toFixed(1)}%)`,
      );
    }
  }
}

await main();
