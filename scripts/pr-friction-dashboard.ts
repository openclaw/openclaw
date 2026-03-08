import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type Args = Record<string, string | boolean>;

type FrictionMetrics = {
  lead_time_hours?: number;
  review_cycles?: number;
  failed_ci_runs_before_merge?: number;
  commits_after_ready_for_review?: number;
  friction_score?: number;
  high_friction_flag?: boolean;
};

type FrictionRow = {
  schema_version?: string;
  event_key?: string;
  repo?: string;
  pr_number?: number;
  merged_at?: string;
  metrics?: FrictionMetrics;
  root_cause_tag?: string | null;
};

type OpenPr = {
  number: number;
  title: string;
  url: string;
  repo: string;
  createdAt: string;
  updatedAt: string;
  author: string;
};

type DashboardSnapshot = {
  generatedAt: string;
  owner: string;
  repoFilter?: string;
  windowDays: number;
  openPr: {
    total: number;
    ageBuckets: {
      lt24h: number;
      d1To3: number;
      d3To7: number;
      gt7d: number;
    };
    staleOver7d: number;
    oldest: OpenPr[];
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
      mergedAt: string;
      score: number;
      reviewCycles: number;
      failedCiRuns: number;
      leadTimeHours: number;
    }>;
  };
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
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
      "pr-friction-dashboard.ts",
      "",
      "Build an in-week PR dashboard + merged-friction snapshot.",
      "",
      "Options:",
      "  --owner <login>          GitHub owner/org login (default: Dodhon)",
      "  --repo <owner/name>      Optional single repo filter",
      "  --window-days <n>        Friction window in days (default: 7)",
      "  --max-open <n>           Max open PRs to include in oldest list (default: 12)",
      "  --input <path>           PR friction JSONL store (default: ./reports/pr-friction.jsonl)",
      "  --output <path>          Markdown output path (default: ./reports/pr-friction-dashboard.md)",
      "  --json-output <path>     Optional JSON snapshot output",
      "  --format <text|json>     Print summary as text (default) or json",
      "",
      "Examples:",
      "  bun scripts/pr-friction-dashboard.ts --owner Dodhon",
      "  bun scripts/pr-friction-dashboard.ts --owner Dodhon --repo Dodhon/Earth --window-days 14",
    ].join("\n"),
  );
  process.exit(code);
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0] ?? null;
  }
  const idx = (sorted.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) {
    return sorted[lower] ?? null;
  }
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? 0;
  const weight = idx - lower;
  return lowerValue * (1 - weight) + upperValue * weight;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null) {
    return null;
  }
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function fmt(value: number | null, suffix = ""): string {
  if (value === null) {
    return "n/a";
  }
  return `${value.toFixed(2)}${suffix}`;
}

function readJsonLines(input: string): Promise<FrictionRow[]> {
  return fs
    .readFile(input, "utf-8")
    .then((raw) => {
      const rows: FrictionRow[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as FrictionRow;
          rows.push(parsed);
        } catch {
          // ignore malformed lines
        }
      }
      return rows;
    })
    .catch(() => []);
}

function ghApi(pathname: string): unknown {
  const out = execFileSync("gh", ["api", pathname], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

function fetchOpenPrs(owner: string, repoFilter: string | undefined): OpenPr[] {
  const query = repoFilter
    ? `repo:${repoFilter} is:pr is:open archived:false`
    : `org:${owner} is:pr is:open archived:false`;
  const encoded = encodeURIComponent(query);
  const pathWithQuery = `search/issues?q=${encoded}&per_page=100`;

  const response = ghApi(pathWithQuery) as {
    items?: Array<{
      number?: number;
      title?: string;
      html_url?: string;
      created_at?: string;
      updated_at?: string;
      user?: { login?: string };
      repository_url?: string;
    }>;
  };

  const items = response.items ?? [];
  const prs: OpenPr[] = [];
  for (const item of items) {
    const number = item.number;
    const title = item.title;
    const url = item.html_url;
    const createdAt = item.created_at;
    const updatedAt = item.updated_at;
    if (
      typeof number !== "number" ||
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof createdAt !== "string" ||
      typeof updatedAt !== "string"
    ) {
      continue;
    }
    const repoUrl = item.repository_url ?? "";
    const parts = repoUrl.split("/repos/");
    const repo = parts[1] ?? repoFilter ?? `${owner}/unknown`;

    prs.push({
      number,
      title,
      url,
      repo,
      createdAt,
      updatedAt,
      author: item.user?.login ?? "unknown",
    });
  }

  return prs;
}

function buildDashboard(
  frictionRows: FrictionRow[],
  openPrs: OpenPr[],
  owner: string,
  repoFilter: string | undefined,
  windowDays: number,
  maxOpen: number,
): DashboardSnapshot {
  const now = Date.now();
  const windowStart = now - windowDays * 24 * 60 * 60 * 1000;

  let lt24h = 0;
  let d1To3 = 0;
  let d3To7 = 0;
  let gt7d = 0;
  let staleOver7d = 0;

  const sortedOpen = [...openPrs].toSorted(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  for (const pr of openPrs) {
    const createdMs = Date.parse(pr.createdAt);
    const updatedMs = Date.parse(pr.updatedAt);
    const ageHours = Math.max(0, (now - createdMs) / (1000 * 60 * 60));
    if (ageHours < 24) {
      lt24h++;
    } else if (ageHours < 72) {
      d1To3++;
    } else if (ageHours < 168) {
      d3To7++;
    } else {
      gt7d++;
    }
    const staleHours = Math.max(0, (now - updatedMs) / (1000 * 60 * 60));
    if (staleHours >= 168) {
      staleOver7d++;
    }
  }

  const filteredFriction = frictionRows.filter((row) => {
    if (!row.repo || !row.merged_at) {
      return false;
    }
    const [rowOwner] = row.repo.split("/");
    if (rowOwner !== owner) {
      return false;
    }
    if (repoFilter && row.repo !== repoFilter) {
      return false;
    }
    const mergedMs = Date.parse(row.merged_at);
    if (!Number.isFinite(mergedMs)) {
      return false;
    }
    return mergedMs >= windowStart;
  });

  const leadValues: number[] = [];
  const cycleValues: number[] = [];
  const failValues: number[] = [];
  const scoreValues: number[] = [];

  let highFriction = 0;
  const repoCount = new Map<string, number>();

  for (const row of filteredFriction) {
    const m = row.metrics ?? {};
    const lead = toNumber(m.lead_time_hours);
    const cycles = toNumber(m.review_cycles);
    const fails = toNumber(m.failed_ci_runs_before_merge);
    const score = toNumber(m.friction_score);

    if (lead !== null) {
      leadValues.push(lead);
    }
    if (cycles !== null) {
      cycleValues.push(cycles);
    }
    if (fails !== null) {
      failValues.push(fails);
    }
    if (score !== null) {
      scoreValues.push(score);
    }
    if (m.high_friction_flag === true) {
      highFriction++;
    }

    const repo = row.repo ?? "unknown/unknown";
    repoCount.set(repo, (repoCount.get(repo) ?? 0) + 1);
  }

  const topRepos = [...repoCount.entries()]
    .map(([repo, count]) => ({ repo, count }))
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 8);

  const highestFriction = filteredFriction
    .map((row) => {
      const m = row.metrics ?? {};
      return {
        repo: row.repo ?? "unknown/unknown",
        prNumber: row.pr_number ?? 0,
        mergedAt: row.merged_at ?? "",
        score: toNumber(m.friction_score) ?? -999,
        reviewCycles: toNumber(m.review_cycles) ?? 0,
        failedCiRuns: toNumber(m.failed_ci_runs_before_merge) ?? 0,
        leadTimeHours: toNumber(m.lead_time_hours) ?? 0,
      };
    })
    .toSorted((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((row) => ({
      ...row,
      score: round(row.score, 3) ?? 0,
      reviewCycles: round(row.reviewCycles, 0) ?? 0,
      failedCiRuns: round(row.failedCiRuns, 0) ?? 0,
      leadTimeHours: round(row.leadTimeHours, 2) ?? 0,
    }));

  return {
    generatedAt: new Date(now).toISOString(),
    owner,
    repoFilter,
    windowDays,
    openPr: {
      total: openPrs.length,
      ageBuckets: { lt24h, d1To3, d3To7, gt7d },
      staleOver7d,
      oldest: sortedOpen.slice(0, Math.max(1, maxOpen)),
    },
    mergedFriction: {
      total: filteredFriction.length,
      highFriction,
      p50: {
        leadTimeHours: round(percentile(leadValues, 0.5)),
        reviewCycles: round(percentile(cycleValues, 0.5)),
        failedCiRuns: round(percentile(failValues, 0.5)),
        frictionScore: round(percentile(scoreValues, 0.5)),
      },
      p90: {
        leadTimeHours: round(percentile(leadValues, 0.9)),
        reviewCycles: round(percentile(cycleValues, 0.9)),
        failedCiRuns: round(percentile(failValues, 0.9)),
        frictionScore: round(percentile(scoreValues, 0.9)),
      },
      topRepos,
      highestFriction,
    },
  };
}

function buildNarrative(snapshot: DashboardSnapshot): string[] {
  const lines: string[] = [];
  const openTotal = snapshot.openPr.total;
  const stale = snapshot.openPr.staleOver7d;
  const merged = snapshot.mergedFriction.total;
  const high = snapshot.mergedFriction.highFriction;

  if (openTotal === 0) {
    lines.push("There are currently no open PRs in scope.");
  } else if (stale > 0) {
    lines.push(
      `Open PR queue has ${openTotal} items, including ${stale} that have not been updated for over 7 days.`,
    );
  } else {
    lines.push(`Open PR queue has ${openTotal} items and none are stale beyond 7 days.`);
  }

  if (merged === 0) {
    lines.push(`No merged PR friction records were found in the last ${snapshot.windowDays} days.`);
  } else if (high > 0) {
    lines.push(
      `${merged} PRs were merged in the last ${snapshot.windowDays} days, and ${high} were flagged high-friction.`,
    );
  } else {
    lines.push(
      `${merged} PRs were merged in the last ${snapshot.windowDays} days with no high-friction flags.`,
    );
  }

  return lines;
}

function renderMarkdown(snapshot: DashboardSnapshot): string {
  const lines: string[] = [];
  const narrative = buildNarrative(snapshot);

  const scope = snapshot.repoFilter ? `repo ${snapshot.repoFilter}` : `org ${snapshot.owner}`;
  lines.push(`# PR Friction Dashboard (${scope})`);
  lines.push("");
  lines.push(`Generated: ${snapshot.generatedAt}`);
  lines.push(`Window: last ${snapshot.windowDays} days`);
  lines.push("");

  lines.push("## This week in plain English");
  for (const sentence of narrative) {
    lines.push(`- ${sentence}`);
  }
  lines.push("");

  lines.push("## Open PR queue (live)");
  lines.push(`- Total open PRs: ${snapshot.openPr.total}`);
  lines.push(
    `- Age buckets: <24h ${snapshot.openPr.ageBuckets.lt24h}, 1-3d ${snapshot.openPr.ageBuckets.d1To3}, 3-7d ${snapshot.openPr.ageBuckets.d3To7}, >7d ${snapshot.openPr.ageBuckets.gt7d}`,
  );
  lines.push(`- Stale >7d (by last update): ${snapshot.openPr.staleOver7d}`);
  lines.push("");

  lines.push("### Oldest open PRs");
  if (snapshot.openPr.oldest.length === 0) {
    lines.push("- none");
  } else {
    for (const pr of snapshot.openPr.oldest) {
      const ageDays = Math.max(0, (Date.now() - Date.parse(pr.createdAt)) / (1000 * 60 * 60 * 24));
      lines.push(
        `- ${pr.repo}#${pr.number} — ${pr.title} (age ${ageDays.toFixed(1)}d, updated ${pr.updatedAt}) <${pr.url}>`,
      );
    }
  }
  lines.push("");

  lines.push(`## Merged PR friction (${snapshot.windowDays}d)`);
  lines.push(`- Merged PRs captured: ${snapshot.mergedFriction.total}`);
  lines.push(`- High-friction merges: ${snapshot.mergedFriction.highFriction}`);
  lines.push(
    `- Lead time (hours): p50 ${fmt(snapshot.mergedFriction.p50.leadTimeHours)}, p90 ${fmt(snapshot.mergedFriction.p90.leadTimeHours)}`,
  );
  lines.push(
    `- Review cycles: p50 ${fmt(snapshot.mergedFriction.p50.reviewCycles)}, p90 ${fmt(snapshot.mergedFriction.p90.reviewCycles)}`,
  );
  lines.push(
    `- Failed CI before merge: p50 ${fmt(snapshot.mergedFriction.p50.failedCiRuns)}, p90 ${fmt(snapshot.mergedFriction.p90.failedCiRuns)}`,
  );
  lines.push(
    `- Friction score: p50 ${fmt(snapshot.mergedFriction.p50.frictionScore)}, p90 ${fmt(snapshot.mergedFriction.p90.frictionScore)}`,
  );
  lines.push("");

  lines.push("### Top repos by merged PR volume");
  if (snapshot.mergedFriction.topRepos.length === 0) {
    lines.push("- none");
  } else {
    for (const row of snapshot.mergedFriction.topRepos) {
      lines.push(`- ${row.repo}: ${row.count}`);
    }
  }
  lines.push("");

  lines.push("### Highest-friction merged PRs");
  if (snapshot.mergedFriction.highestFriction.length === 0) {
    lines.push("- none");
  } else {
    for (const row of snapshot.mergedFriction.highestFriction) {
      lines.push(
        `- ${row.repo}#${row.prNumber}: score ${row.score.toFixed(3)}, cycles ${row.reviewCycles}, failed CI ${row.failedCiRuns}, lead ${row.leadTimeHours.toFixed(2)}h (merged ${row.mergedAt})`,
      );
    }
  }
  lines.push("");

  lines.push("## Suggested weekly actions");
  if (snapshot.openPr.staleOver7d > 0) {
    lines.push(
      "- Prioritize stale PR triage: assign reviewer/owner and clear blockers for PRs stale >7 days.",
    );
  } else {
    lines.push("- Keep PR queue freshness: maintain review SLA to prevent stale buildup.");
  }
  if (snapshot.mergedFriction.highFriction > 0) {
    lines.push(
      "- Tag root causes on high-friction merges (scope drift, test gap, review mismatch, CI flakiness). ",
    );
  } else {
    lines.push("- Continue collecting samples; refine thresholds once weekly merge count grows.");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help === true) {
    usageAndExit(0);
  }

  const owner = typeof args.owner === "string" ? args.owner : "Dodhon";
  const repoFilter = typeof args.repo === "string" ? args.repo : undefined;

  const windowDaysRaw = typeof args["window-days"] === "string" ? Number(args["window-days"]) : 7;
  const windowDays =
    Number.isFinite(windowDaysRaw) && windowDaysRaw > 0 ? Math.floor(windowDaysRaw) : 7;

  const maxOpenRaw = typeof args["max-open"] === "string" ? Number(args["max-open"]) : 12;
  const maxOpen = Number.isFinite(maxOpenRaw) && maxOpenRaw > 0 ? Math.floor(maxOpenRaw) : 12;

  const input =
    typeof args.input === "string"
      ? args.input
      : path.join(process.cwd(), "reports", "pr-friction.jsonl");
  const output =
    typeof args.output === "string"
      ? args.output
      : path.join(process.cwd(), "reports", "pr-friction-dashboard.md");
  const jsonOutput = typeof args["json-output"] === "string" ? args["json-output"] : undefined;

  const format = typeof args.format === "string" ? args.format : "text";
  if (format !== "text" && format !== "json") {
    usageAndExit(2);
  }

  const frictionRows = await readJsonLines(input);

  let openPrs: OpenPr[] = [];
  try {
    openPrs = fetchOpenPrs(owner, repoFilter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`warning: failed to fetch open PR data via gh api: ${message}`);
  }

  const snapshot = buildDashboard(frictionRows, openPrs, owner, repoFilter, windowDays, maxOpen);

  const markdown = renderMarkdown(snapshot);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, markdown, "utf-8");

  if (jsonOutput) {
    await fs.mkdir(path.dirname(jsonOutput), { recursive: true });
    await fs.writeFile(jsonOutput, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  }

  if (format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          status: "ok",
          output,
          jsonOutput: jsonOutput ?? null,
          snapshot,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  console.log(`[ok] dashboard written to ${output}`);
  if (jsonOutput) {
    console.log(`[ok] json snapshot written to ${jsonOutput}`);
  }
  console.log(
    `open_pr_total=${snapshot.openPr.total} merged_window_total=${snapshot.mergedFriction.total}`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] ${message}`);
  process.exit(1);
});
