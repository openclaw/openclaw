import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, readToken, todayYmd, nowIso } from "./util.js";
import { listProjects, SupabaseAuthError } from "./list-projects.js";
import { scanProject } from "./scan-project.js";
import {
  notifyAuthBroken,
  notifyForReport,
  type NotifyConfig,
} from "./notify.js";
import type { ProjectScanResult, ScanReport } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist/index.js → repo root is one level up from dist/.
const ROOT = resolve(__dirname, "..");

interface CliOpts {
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  return { dryRun: argv.includes("--dry-run") };
}

async function loadAllowlist(): Promise<string[]> {
  const path = resolve(ROOT, "data", "allowlist.json");
  try {
    const buf = await readFile(path, "utf8");
    const parsed = JSON.parse(buf);
    if (Array.isArray(parsed)) return parsed.map(String);
    return [];
  } catch {
    return [];
  }
}

function buildNotifyConfig(): NotifyConfig {
  return {
    imsgBin: process.env.IMSG_BIN || "/opt/homebrew/bin/imsg",
    recipient: process.env.ALERT_RECIPIENT || "+15166334684",
    fallbackEmail: process.env.ALERT_EMAIL || "jeff@hypelab.digital",
    stateDir: resolve(ROOT, "logs"),
  };
}

async function writeReport(report: ScanReport, ymd: string): Promise<string> {
  const dir = resolve(ROOT, "logs");
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `scan-${ymd}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  return path;
}

function summarize(report: ScanReport): string {
  const lines: string[] = [];
  lines.push(
    `[${report.timestamp}] scanned ${report.projects_scanned}/${report.projects_total} projects in ${report.duration_ms}ms`
  );
  for (const r of report.results) {
    lines.push(
      `  - ${r.project.name} (${r.project.ref}): tables=${r.tables_scanned} rls_off=${r.tables_rls_off} findings=${r.findings.length}`
    );
    for (const f of r.findings) {
      lines.push(
        `      [${f.severity}] ${f.table} probe=${f.probe.status}${
          f.probe.http_status ? " http=" + f.probe.http_status : ""
        }${
          f.probe.rows_returned !== undefined
            ? " rows=" + f.probe.rows_returned
            : ""
        }`
      );
    }
    for (const e of r.errors) lines.push(`      ! ${e}`);
  }
  if (report.errors.length > 0) {
    lines.push("Top-level errors:");
    for (const e of report.errors) lines.push(`  ! ${e}`);
  }
  lines.push(
    `High findings: ${report.high_findings} | Medium findings: ${report.medium_findings}`
  );
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tokenPath =
    process.env.SUPABASE_TOKEN_PATH || "~/.config/openclaw/supabase-token";
  const start = Date.now();
  const ymd = todayYmd();
  const notifyCfg = buildNotifyConfig();

  let token: string;
  try {
    token = await readToken(tokenPath);
  } catch (err) {
    const msg = `Token read failed: ${(err as Error).message}`;
    console.error(msg);
    process.exit(2);
  }

  const allowlist = await loadAllowlist();

  let projects;
  try {
    projects = await listProjects(token);
  } catch (err) {
    if (err instanceof SupabaseAuthError) {
      console.error(`Supabase auth broken: ${err.message}`);
      if (!opts.dryRun) {
        await notifyAuthBroken(notifyCfg);
      }
      process.exit(3);
    }
    console.error(`List projects failed: ${(err as Error).message}`);
    process.exit(4);
  }

  const results: ProjectScanResult[] = [];
  const topErrors: string[] = [];
  let scanned = 0;
  let failed = 0;
  for (const p of projects) {
    if (p.status && p.status !== "ACTIVE_HEALTHY") {
      results.push({
        project: p,
        tables_scanned: 0,
        tables_rls_off: 0,
        findings: [],
        errors: [`skipped: status=${p.status}`],
      });
      continue;
    }
    try {
      const r = await scanProject(token, p, allowlist);
      results.push(r);
      scanned++;
    } catch (err) {
      failed++;
      const msg = `scan ${p.name} (${p.ref}): ${(err as Error).message}`;
      topErrors.push(msg);
      results.push({
        project: p,
        tables_scanned: 0,
        tables_rls_off: 0,
        findings: [],
        errors: [(err as Error).message],
      });
    }
  }

  const high = results.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === "high").length,
    0
  );
  const medium = results.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === "medium").length,
    0
  );

  const report: ScanReport = {
    timestamp: nowIso(),
    duration_ms: Date.now() - start,
    projects_total: projects.length,
    projects_scanned: scanned,
    projects_failed: failed,
    high_findings: high,
    medium_findings: medium,
    results,
    errors: topErrors,
  };

  const logPath = await writeReport(report, ymd);
  console.log(summarize(report));
  console.log(`Wrote ${logPath}`);

  if (!opts.dryRun) {
    const msgs = await notifyForReport(notifyCfg, report, ymd);
    for (const m of msgs) console.log(m);
  } else {
    console.log("(dry-run) skipping notifications");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
