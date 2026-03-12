import fs from "node:fs/promises";
import path from "node:path";

type Snapshot = {
  generatedAt: string;
  owner: string;
  repoFilter?: string;
  windowDays: number;
  openPr: {
    total: number;
    ageBuckets: { lt24h: number; d1To3: number; d3To7: number; gt7d: number };
    staleOver7d: number;
    oldest: Array<{ repo: string; number: number; title: string; url: string }>;
  };
  mergedFriction: {
    total: number;
    highFriction: number;
    p50: {
      leadTimeHours: number | null;
      reviewCycles: number | null;
      failedCiRuns: number | null;
      frictionScore: number | null;
    };
    p90: {
      leadTimeHours: number | null;
      reviewCycles: number | null;
      failedCiRuns: number | null;
      frictionScore: number | null;
    };
    topRepos: Array<{ repo: string; count: number }>;
    highestFriction: Array<{
      repo: string;
      prNumber: number;
      score: number;
      reviewCycles: number;
      failedCiRuns: number;
      leadTimeHours: number;
    }>;
  };
};

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function usageAndExit(code: number): never {
  console.error(
    [
      "pr-friction-summary.ts",
      "",
      "Render a human-readable daily/weekly summary from dashboard JSON.",
      "",
      "Options:",
      "  --input <path>         Dashboard JSON path (required)",
      "  --format <text|json>   Output mode (default: text)",
      "",
      "Example:",
      "  bun scripts/pr-friction-summary.ts --input reports/pr-friction-dashboard.json",
    ].join("\n"),
  );
  process.exit(code);
}

function fmt(value: number | null, suffix = ""): string {
  if (value === null) {
    return "n/a";
  }
  return `${value.toFixed(2)}${suffix}`;
}

function scopeLabel(snapshot: Snapshot): string {
  return snapshot.repoFilter ? snapshot.repoFilter : `${snapshot.owner} (org scope)`;
}

function render(snapshot: Snapshot): string {
  const lines: string[] = [];

  lines.push(`PR dashboard update (${scopeLabel(snapshot)})`);
  lines.push("");

  const open = snapshot.openPr;
  const merged = snapshot.mergedFriction;

  lines.push("This week in plain English:");
  if (open.total === 0) {
    lines.push("- Open queue is empty right now.");
  } else if (open.staleOver7d > 0) {
    lines.push(
      `- Open queue has ${open.total} PRs, with ${open.staleOver7d} stale for over 7 days (needs triage).`,
    );
  } else {
    lines.push(`- Open queue has ${open.total} PRs and no stale backlog over 7 days.`);
  }

  if (merged.total === 0) {
    lines.push(`- No merged PR friction records found in the last ${snapshot.windowDays} days.`);
  } else if (merged.highFriction > 0) {
    lines.push(
      `- ${merged.total} merges in the last ${snapshot.windowDays} days, including ${merged.highFriction} high-friction merges.`,
    );
  } else {
    lines.push(
      `- ${merged.total} merges in the last ${snapshot.windowDays} days with no high-friction flags.`,
    );
  }
  lines.push("");

  lines.push("Key numbers:");
  lines.push(`- Open PRs: ${open.total}`);
  lines.push(
    `- Open PR age buckets: <24h ${open.ageBuckets.lt24h}, 1-3d ${open.ageBuckets.d1To3}, 3-7d ${open.ageBuckets.d3To7}, >7d ${open.ageBuckets.gt7d}`,
  );
  lines.push(`- Merged PRs in window: ${merged.total}`);
  lines.push(`- High-friction merges: ${merged.highFriction}`);
  lines.push(
    `- Lead time (hours): p50 ${fmt(merged.p50.leadTimeHours)}, p90 ${fmt(merged.p90.leadTimeHours)}`,
  );
  lines.push(
    `- Review cycles: p50 ${fmt(merged.p50.reviewCycles)}, p90 ${fmt(merged.p90.reviewCycles)}`,
  );
  lines.push(
    `- Failed CI before merge: p50 ${fmt(merged.p50.failedCiRuns)}, p90 ${fmt(merged.p90.failedCiRuns)}`,
  );
  lines.push(
    `- Friction score: p50 ${fmt(merged.p50.frictionScore)}, p90 ${fmt(merged.p90.frictionScore)}`,
  );
  lines.push("");

  lines.push("Where to focus next:");
  if (open.staleOver7d > 0) {
    lines.push("- Clear stale open PRs first (assign reviewer + owner, then close/merge). ");
  } else {
    lines.push("- Keep review latency low; prevent stale PR buildup.");
  }
  if (merged.highFriction > 0) {
    lines.push("- Tag root causes for high-friction merges this week.");
  } else {
    lines.push("- Keep collecting data; revisit thresholds after higher merge volume.");
  }

  if (open.oldest.length > 0) {
    lines.push("");
    lines.push("Oldest open PRs:");
    for (const pr of open.oldest.slice(0, 3)) {
      lines.push(`- ${pr.repo}#${pr.number} — ${pr.title} <${pr.url}>`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const input = typeof args.input === "string" ? args.input : undefined;
  if (!input) {
    usageAndExit(2);
  }

  const format = typeof args.format === "string" ? args.format : "text";
  if (format !== "text" && format !== "json") {
    usageAndExit(2);
  }

  const raw = await fs.readFile(path.resolve(input), "utf-8");
  const snapshot = JSON.parse(raw) as Snapshot;
  const message = render(snapshot);

  if (format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          status: "ok",
          input: path.resolve(input),
          message,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  process.stdout.write(message);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] ${message}`);
  process.exit(1);
});
