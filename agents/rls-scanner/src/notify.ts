import { spawn } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { expandHome } from "./util.js";
import type { ProjectScanResult, ScanReport } from "./types.js";

export interface NotifyConfig {
  imsgBin: string;
  recipient: string;
  fallbackEmail?: string;
  stateDir: string;
}

export async function sendImessage(
  cfg: NotifyConfig,
  text: string
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolveP) => {
    const p = spawn(cfg.imsgBin, [
      "send",
      "--to",
      cfg.recipient,
      "--text",
      text,
      "--service",
      "imessage",
    ]);
    let stderr = "";
    let stdout = "";
    p.stdout.on("data", (b) => (stdout += b));
    p.stderr.on("data", (b) => (stderr += b));
    p.on("error", (e) => resolveP({ ok: false, detail: e.message }));
    p.on("exit", (code) => {
      resolveP({
        ok: code === 0,
        detail: code === 0 ? stdout.trim() : `exit=${code} ${stderr.trim()}`,
      });
    });
  });
}

async function emailFallback(
  cfg: NotifyConfig,
  subject: string,
  body: string
): Promise<{ ok: boolean; detail: string }> {
  if (!cfg.fallbackEmail) return { ok: false, detail: "no fallback email" };
  // Best-effort fallback via macOS `mail` command if present; otherwise log only.
  return new Promise((resolveP) => {
    const p = spawn("mail", ["-s", subject, cfg.fallbackEmail!], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    p.stderr.on("data", (b) => (stderr += b));
    p.on("error", (e) => resolveP({ ok: false, detail: `mail: ${e.message}` }));
    p.on("exit", (code) =>
      resolveP({
        ok: code === 0,
        detail: code === 0 ? "mail sent" : `mail exit=${code} ${stderr.trim()}`,
      })
    );
    p.stdin.write(body);
    p.stdin.end();
  });
}

export function buildLeakAlert(
  reportDate: string,
  highFindings: { project: string; tables: string[] }[]
): string {
  const lines: string[] = [];
  for (const h of highFindings) {
    lines.push(`🚨 RLS leak detected in ${h.project}`);
    lines.push(`Tables: ${h.tables.join(", ")}`);
  }
  lines.push(
    `Run: cat ~/code/openclaw/agents/rls-scanner/logs/scan-${reportDate}.json for details.`
  );
  return lines.join("\n");
}

export function collectHighFindings(
  results: ProjectScanResult[]
): { project: string; tables: string[] }[] {
  const out: { project: string; tables: string[] }[] = [];
  for (const r of results) {
    const tables = r.findings
      .filter((f) => f.severity === "high")
      .map((f) => f.table);
    if (tables.length > 0) out.push({ project: r.project.name, tables });
  }
  return out;
}

interface NotifyState {
  last_all_clear?: string; // ISO date YYYY-MM-DD of last bi-weekly ping
  last_alert?: string;
}

async function loadState(stateFile: string): Promise<NotifyState> {
  try {
    const buf = await readFile(stateFile, "utf8");
    return JSON.parse(buf) as NotifyState;
  } catch {
    return {};
  }
}

async function saveState(stateFile: string, s: NotifyState): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(s, null, 2));
}

/**
 * Decide whether today is a bi-weekly all-clear day.
 * Rule: every other Monday, anchored to ISO week parity (week % 2 === 0).
 * Combined with state to avoid double-pings on the same day.
 */
export function shouldSendAllClear(date: Date, state: NotifyState): boolean {
  const day = date.getUTCDay(); // 1 = Monday
  if (day !== 1) return false;
  const isoWeek = isoWeekNumber(date);
  if (isoWeek % 2 !== 0) return false;
  const ymd = date.toISOString().slice(0, 10);
  if (state.last_all_clear === ymd) return false;
  return true;
}

function isoWeekNumber(date: Date): number {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7
  );
}

export async function notifyForReport(
  cfg: NotifyConfig,
  report: ScanReport,
  reportDate: string
): Promise<string[]> {
  const stateFile = resolve(expandHome(cfg.stateDir), "notify-state.json");
  const state = await loadState(stateFile);
  const messages: string[] = [];

  const high = collectHighFindings(report.results);
  if (high.length > 0) {
    const text = buildLeakAlert(reportDate, high);
    const r = await sendImessage(cfg, text);
    messages.push(`imsg leak alert: ok=${r.ok} ${r.detail}`);
    if (!r.ok) {
      const fb = await emailFallback(cfg, "RLS leak detected", text);
      messages.push(`email fallback: ok=${fb.ok} ${fb.detail}`);
    }
    state.last_alert = reportDate;
    await saveState(stateFile, state);
    return messages;
  }

  // No high findings — maybe send the bi-weekly all-clear.
  if (shouldSendAllClear(new Date(), state)) {
    const text = `✅ RLS scanner all-clear (${reportDate}). Projects: ${report.projects_scanned}/${report.projects_total}. Medium notes: ${report.medium_findings}.`;
    const r = await sendImessage(cfg, text);
    messages.push(`imsg all-clear: ok=${r.ok} ${r.detail}`);
    state.last_all_clear = reportDate;
    await saveState(stateFile, state);
  }
  return messages;
}

export async function notifyAuthBroken(
  cfg: NotifyConfig
): Promise<{ ok: boolean; detail: string }> {
  const text =
    "🚨 RLS scanner auth broken — re-mint Supabase access token at https://supabase.com/dashboard/account/tokens";
  const r = await sendImessage(cfg, text);
  if (!r.ok && cfg.fallbackEmail) {
    await emailFallback(cfg, "RLS scanner auth broken", text);
  }
  return r;
}
