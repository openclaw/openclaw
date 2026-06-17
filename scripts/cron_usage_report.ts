import fs from "node:fs/promises";
import path from "node:path";

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};

type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: "finished";
  status?: "ok" | "error" | "skipped";
  model?: string;
  provider?: string;
  usage?: Usage;
  estimated_cost_usd?: number;
};

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) {
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function usageAndExit(code: number): never {
  console.error(
    [
      "cron_usage_report.ts",
      "",
      "Required (choose one):",
      "  --store <path-to-cron-store-json>   (derive runs dir as dirname(store)/runs)",
      "  --runsDir <path-to-runs-dir>",
      "",
      "Time window:",
      "  --hours <n>        (default 24)",
      "  --from <iso>       (overrides --hours)",
      "  --to <iso>         (default now)",
      "",
      "Filters:",
      "  --jobId <id>",
      "  --model <name>",
      "",
      "Output:",
      "  --json             (emit JSON)",
    ].join("\n"),
  );
  process.exit(code);
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(dir, e.name));
}

function safeParseLine(line: string): CronRunLogEntry | null {
  try {
    const obj = JSON.parse(line) as Partial<CronRunLogEntry> | null;
    if (!obj || typeof obj !== "object") {
      return null;
    }
    if (obj.action !== "finished") {
      return null;
    }
    if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) {
      return null;
    }
    if (typeof obj.jobId !== "string" || !obj.jobId.trim()) {
      return null;
    }
    return obj as CronRunLogEntry;
  } catch {
    return null;
  }
}

function fmtInt(n: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

function fmtUsd(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(n);
}

type UsageTotals = {
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
  missingUsageRuns: number;
};

function newUsageTotals(): Omit<UsageTotals, "runs" | "missingUsageRuns"> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
}

export async function main() {
  const args = parseArgs(process.argv);
  const store = typeof args.store === "string" ? args.store : undefined;
  const runsDirArg = typeof args.runsDir === "string" ? args.runsDir : undefined;
  const runsDir =
    runsDirArg ?? (store ? path.join(path.dirname(path.resolve(store)), "runs") : null);
  if (!runsDir) {
    usageAndExit(2);
  }

  const hours = typeof args.hours === "string" ? Number(args.hours) : 24;
  const toMs = typeof args.to === "string" ? Date.parse(args.to) : Date.now();
  const fromMs =
    typeof args.from === "string"
      ? Date.parse(args.from)
      : toMs - Math.max(1, Number.isFinite(hours) ? hours : 24) * 60 * 60 * 1000;

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    console.error("Invalid --from/--to timestamp");
    process.exit(2);
  }

  const filterJobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
  const filterModel = typeof args.model === "string" ? args.model.trim() : "";
  const asJson = args.json === true;

  const files = await listJsonlFiles(runsDir);
  const totalsByJob: Record<
    string,
    {
      jobId: string;
      models: Record<string, { model: string } & UsageTotals>;
    } & UsageTotals
  > = {};

  for (const file of files) {
    const raw = await fs.readFile(file, "utf-8").catch(() => "");
    if (!raw.trim()) {
      continue;
    }
    const lines = raw.split("\n");
    for (const line of lines) {
      const entry = safeParseLine(line.trim());
      if (!entry) {
        continue;
      }
      if (entry.ts < fromMs || entry.ts > toMs) {
        continue;
      }
      if (filterJobId && entry.jobId !== filterJobId) {
        continue;
      }
      const model = (entry.model ?? "<unknown>").trim() || "<unknown>";
      if (filterModel && model !== filterModel) {
        continue;
      }

      const jobId = entry.jobId;
      const usage = entry.usage;
      const hasUsage = Boolean(
        usage && (usage.total_tokens ?? usage.input_tokens ?? usage.output_tokens) !== undefined,
      );

      const jobAgg = (totalsByJob[jobId] ??= {
        jobId,
        runs: 0,
        models: {},
        missingUsageRuns: 0,
        ...newUsageTotals(),
      });
      jobAgg.runs++;

      const modelAgg = (jobAgg.models[model] ??= {
        model,
        runs: 0,
        missingUsageRuns: 0,
        ...newUsageTotals(),
      });
      modelAgg.runs++;

      // Cost is snapshotted per run, so it is meaningful even when token usage
      // is absent (e.g. provider returned cost without token counts).
      const rawCost = entry.estimated_cost_usd ?? 0;
      const cost = Number.isFinite(rawCost) ? Math.max(0, rawCost) : 0;
      jobAgg.cost_usd += cost;
      modelAgg.cost_usd += cost;

      if (!hasUsage) {
        jobAgg.missingUsageRuns++;
        modelAgg.missingUsageRuns++;
        continue;
      }

      const input = Math.max(0, Math.trunc(usage?.input_tokens ?? 0));
      const output = Math.max(0, Math.trunc(usage?.output_tokens ?? 0));
      const cacheRead = Math.max(0, Math.trunc(usage?.cache_read_tokens ?? 0));
      const cacheWrite = Math.max(0, Math.trunc(usage?.cache_write_tokens ?? 0));
      // The logged `total_tokens` is a prompt/context snapshot (input + cache,
      // excludes output). Billable consumption = prompt side + output. Fall
      // back to the component sum for older logs without `total_tokens`.
      const promptSide =
        usage?.total_tokens !== undefined
          ? Math.max(0, Math.trunc(usage.total_tokens))
          : input + cacheRead + cacheWrite;
      const total = promptSide + output;

      jobAgg.input_tokens += input;
      jobAgg.output_tokens += output;
      jobAgg.cache_read_tokens += cacheRead;
      jobAgg.cache_write_tokens += cacheWrite;
      jobAgg.total_tokens += total;

      modelAgg.input_tokens += input;
      modelAgg.output_tokens += output;
      modelAgg.cache_read_tokens += cacheRead;
      modelAgg.cache_write_tokens += cacheWrite;
      modelAgg.total_tokens += total;
    }
  }

  const rows = Object.values(totalsByJob)
    .map((r) =>
      Object.assign({}, r, {
        models: Object.values(r.models).toSorted((a, b) => b.total_tokens - a.total_tokens),
      }),
    )
    .toSorted((a, b) => b.total_tokens - a.total_tokens);

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          runsDir,
          jobs: rows,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  console.log(`Cron usage report`);
  console.log(`  runsDir: ${runsDir}`);
  console.log(`  window: ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}`);
  if (filterJobId) {
    console.log(`  filter jobId: ${filterJobId}`);
  }
  if (filterModel) {
    console.log(`  filter model: ${filterModel}`);
  }
  console.log("");

  if (rows.length === 0) {
    console.log("No matching cron run entries found.");
    return;
  }

  const grand = rows.reduce(
    (acc, r) => {
      acc.runs += r.runs;
      acc.total_tokens += r.total_tokens;
      acc.cost_usd += r.cost_usd;
      return acc;
    },
    { runs: 0, total_tokens: 0, cost_usd: 0 },
  );

  for (const job of rows) {
    console.log(`jobId: ${job.jobId}`);
    console.log(`  runs: ${fmtInt(job.runs)} (missing usage: ${fmtInt(job.missingUsageRuns)})`);
    console.log(`  cost: ${fmtUsd(job.cost_usd)}`);
    console.log(
      `  tokens: total ${fmtInt(job.total_tokens)} (in ${fmtInt(job.input_tokens)} / out ${fmtInt(job.output_tokens)} / cache ${fmtInt(job.cache_read_tokens)} read + ${fmtInt(job.cache_write_tokens)} write)`,
    );
    for (const m of job.models) {
      console.log(
        `    model ${m.model}: runs ${fmtInt(m.runs)} (missing usage: ${fmtInt(m.missingUsageRuns)}), cost ${fmtUsd(m.cost_usd)}, total ${fmtInt(m.total_tokens)} (in ${fmtInt(m.input_tokens)} / out ${fmtInt(m.output_tokens)} / cache ${fmtInt(m.cache_read_tokens)} read + ${fmtInt(m.cache_write_tokens)} write)`,
      );
    }
    console.log("");
  }

  console.log(
    `TOTAL: ${fmtUsd(grand.cost_usd)} across ${fmtInt(grand.runs)} runs, ${fmtInt(grand.total_tokens)} tokens`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
