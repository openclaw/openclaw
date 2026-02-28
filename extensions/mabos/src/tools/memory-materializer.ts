/**
 * Memory Materializer — Writes MABOS structured data as Markdown files
 * that OpenClaw's chokidar watcher auto-detects and indexes with vector+BM25.
 *
 * By writing to `memory/*.md` inside agent workspaces, we get free
 * hybrid search indexing with zero OpenClaw core modifications.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveWorkspaceDir } from "./common.js";

async function readJson(p: string): Promise<any> {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

async function readMd(p: string): Promise<string> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

async function writeMd(p: string, content: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content, "utf-8");
}

/**
 * Materialize facts.json as a searchable Markdown file.
 */
export async function materializeFacts(api: OpenClawPluginApi, agentId: string): Promise<void> {
  const ws = resolveWorkspaceDir(api);
  const factsPath = join(ws, "agents", agentId, "facts.json");
  const outPath = join(ws, "agents", agentId, "memory", "mabos-facts.md");

  const store = await readJson(factsPath);
  if (!store?.facts?.length) return;

  const lines: string[] = [
    `# MABOS Facts — ${agentId}`,
    "",
    `> Auto-materialized from facts.json. ${store.facts.length} facts.`,
    "",
  ];

  for (const fact of store.facts) {
    lines.push(`## ${fact.subject} ${fact.predicate} ${fact.object}`);
    lines.push("");
    lines.push(`- **ID:** ${fact.id}`);
    lines.push(`- **Confidence:** ${fact.confidence}`);
    lines.push(`- **Source:** ${fact.source}`);
    if (fact.valid_from) lines.push(`- **Valid from:** ${fact.valid_from}`);
    if (fact.valid_until) lines.push(`- **Valid until:** ${fact.valid_until}`);
    if (fact.derived_from?.length) {
      lines.push(`- **Derived from:** ${fact.derived_from.join(", ")}`);
    }
    lines.push("");
  }

  await writeMd(outPath, lines.join("\n"));
}

/**
 * Materialize BDI cognitive files (Beliefs, Desires, Goals) as a single searchable file.
 */
export async function materializeBeliefs(api: OpenClawPluginApi, agentId: string): Promise<void> {
  const ws = resolveWorkspaceDir(api);
  const agentDir = join(ws, "agents", agentId);
  const outPath = join(agentDir, "memory", "mabos-beliefs.md");

  const beliefs = await readMd(join(agentDir, "Beliefs.md"));
  const desires = await readMd(join(agentDir, "Desires.md"));
  const goals = await readMd(join(agentDir, "Goals.md"));

  if (!beliefs && !desires && !goals) return;

  const lines: string[] = [
    `# MABOS BDI State — ${agentId}`,
    "",
    `> Auto-materialized from Beliefs.md, Desires.md, Goals.md`,
    "",
  ];

  if (beliefs) {
    lines.push("## Beliefs");
    lines.push("");
    lines.push(beliefs.trim());
    lines.push("");
  }

  if (desires) {
    lines.push("## Desires");
    lines.push("");
    lines.push(desires.trim());
    lines.push("");
  }

  if (goals) {
    lines.push("## Goals");
    lines.push("");
    lines.push(goals.trim());
    lines.push("");
  }

  await writeMd(outPath, lines.join("\n"));
}

/**
 * Materialize memory-store.json (long-term + short-term) as a searchable Markdown file.
 */
export async function materializeMemoryItems(
  api: OpenClawPluginApi,
  agentId: string,
): Promise<void> {
  const ws = resolveWorkspaceDir(api);
  const storePath = join(ws, "agents", agentId, "memory-store.json");
  const outPath = join(ws, "agents", agentId, "memory", "mabos-memory-items.md");

  const store = await readJson(storePath);
  if (!store) return;

  const longTerm: any[] = store.long_term || [];
  const shortTerm: any[] = store.short_term || [];
  const allItems = [
    ...longTerm.map((i: any) => ({ ...i, _store: "long_term" })),
    ...shortTerm.map((i: any) => ({ ...i, _store: "short_term" })),
  ];

  if (allItems.length === 0) return;

  const lines: string[] = [
    `# MABOS Memory Items — ${agentId}`,
    "",
    `> Auto-materialized from memory-store.json. ${longTerm.length} long-term, ${shortTerm.length} short-term items.`,
    "",
  ];

  for (const item of allItems) {
    lines.push(`## [${item._store}] ${item.type}: ${item.content.slice(0, 120)}`);
    lines.push("");
    lines.push(`- **ID:** ${item.id}`);
    lines.push(`- **Store:** ${item._store}`);
    lines.push(`- **Type:** ${item.type}`);
    lines.push(`- **Importance:** ${item.importance}`);
    lines.push(`- **Source:** ${item.source}`);
    if (item.tags?.length) lines.push(`- **Tags:** ${item.tags.join(", ")}`);
    if (item.derived_from?.length)
      lines.push(`- **Derived from:** ${item.derived_from.join(", ")}`);
    lines.push(`- **Created:** ${item.created_at}`);
    if (item.observed_at && item.observed_at !== item.created_at)
      lines.push(`- **Observed:** ${item.observed_at}`);
    if (item.referenced_dates?.length)
      lines.push(`- **Referenced dates:** ${item.referenced_dates.join(", ")}`);
    lines.push("");
    lines.push(item.content);
    lines.push("");
  }

  await writeMd(outPath, lines.join("\n"));
}

// ── R2: Hierarchical Memory Index materialization ──

function getISOWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function getQuarter(month: number): number {
  return Math.floor(month / 3) + 1;
}

export async function materializeWeeklySummary(
  api: OpenClawPluginApi,
  agentId: string,
  weekStart: string,
): Promise<void> {
  const ws = resolveWorkspaceDir(api);
  const memoryDir = join(ws, "agents", agentId, "memory");
  const startDate = new Date(weekStart);
  const { year, week } = getISOWeek(startDate);
  const weekLabel = `${year}-W${String(week).padStart(2, "0")}`;
  const outPath = join(memoryDir, "weekly", `${weekLabel}.md`);

  const days: string[] = [];
  for (let d = 0; d < 7; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dateStr = date.toISOString().split("T")[0];
    const dayContent = await readMd(join(memoryDir, `${dateStr}.md`));
    if (dayContent.trim()) {
      days.push(`## ${dateStr}\n${dayContent.trim()}`);
    }
  }

  if (days.length === 0) return;

  const lines: string[] = [
    `# Weekly Summary — ${weekLabel}`,
    "",
    `> Auto-generated weekly digest covering ${days.length} day(s).`,
    "",
    ...days.flatMap((d) => [d, ""]),
  ];

  await writeMd(outPath, lines.join("\n"));
}

export async function materializeMonthlySummary(
  api: OpenClawPluginApi,
  agentId: string,
  month: string,
): Promise<void> {
  const ws = resolveWorkspaceDir(api);
  const memoryDir = join(ws, "agents", agentId, "memory");
  const outPath = join(memoryDir, "monthly", `${month}.md`);

  // Read all weekly summaries for this month
  const weeklyDir = join(memoryDir, "weekly");
  let weeklyFiles: string[] = [];
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(weeklyDir);
    weeklyFiles = files.filter((f) => f.endsWith(".md")).sort();
  } catch {
    // No weekly dir yet
  }

  // Filter to weeks that overlap with this month
  const [yearStr, monthStr] = month.split("-");
  const monthStart = new Date(`${month}-01`);
  const nextMonth = new Date(monthStart);
  nextMonth.setMonth(nextMonth.getMonth() + 1);

  const sections: string[] = [];
  for (const wf of weeklyFiles) {
    const weekContent = await readMd(join(weeklyDir, wf));
    if (weekContent.trim()) {
      sections.push(`## ${wf.replace(".md", "")}\n${weekContent.trim()}`);
    }
  }

  // Also read any daily logs directly for days not covered by weeklies
  const { readdir } = await import("node:fs/promises");
  let dailyFiles: string[] = [];
  try {
    const allFiles = await readdir(memoryDir);
    dailyFiles = allFiles
      .filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.md$/) && f.startsWith(month))
      .sort();
  } catch {
    // No daily files
  }

  if (sections.length === 0 && dailyFiles.length === 0) return;

  const lines: string[] = [
    `# Monthly Summary — ${month}`,
    "",
    `> Auto-generated monthly digest.`,
    "",
  ];

  if (sections.length > 0) {
    lines.push("# Weekly Digests", "");
    for (const s of sections) lines.push(s, "");
  }

  if (dailyFiles.length > 0) {
    lines.push("# Daily Entries", "");
    for (const df of dailyFiles) {
      const dayContent = await readMd(join(memoryDir, df));
      if (dayContent.trim()) {
        lines.push(`## ${df.replace(".md", "")}`, dayContent.trim(), "");
      }
    }
  }

  await writeMd(outPath, lines.join("\n"));
}

export async function materializeQuarterlyReview(
  api: OpenClawPluginApi,
  agentId: string,
  quarter: string,
): Promise<void> {
  const ws = resolveWorkspaceDir(api);
  const memoryDir = join(ws, "agents", agentId, "memory");
  const outPath = join(memoryDir, "quarterly", `${quarter}.md`);

  // quarter format: "2026-Q1"
  const [yearStr, qStr] = quarter.split("-Q");
  const q = parseInt(qStr, 10);
  const startMonth = (q - 1) * 3; // 0-indexed

  const sections: string[] = [];
  for (let m = startMonth; m < startMonth + 3; m++) {
    const monthStr = `${yearStr}-${String(m + 1).padStart(2, "0")}`;
    const monthlyPath = join(memoryDir, "monthly", `${monthStr}.md`);
    const monthContent = await readMd(monthlyPath);
    if (monthContent.trim()) {
      sections.push(`## ${monthStr}\n${monthContent.trim()}`);
    }
  }

  if (sections.length === 0) return;

  const lines: string[] = [
    `# Quarterly Review — ${quarter}`,
    "",
    `> Auto-generated quarterly review covering ${sections.length} month(s).`,
    "",
    ...sections.flatMap((s) => [s, ""]),
  ];

  await writeMd(outPath, lines.join("\n"));
}

/**
 * Materialize observation log as a searchable Markdown file.
 */
export async function materializeObservations(
  api: OpenClawPluginApi,
  agentId: string,
): Promise<void> {
  const ws = resolveWorkspaceDir(api);
  const logPath = join(ws, "agents", agentId, "observation-log.json");
  const outPath = join(ws, "agents", agentId, "memory", "mabos-observations.md");

  const store = await readJson(logPath);
  if (!store?.observations?.length) return;

  const { formatObservationLog } = await import("./observer.js");
  const formatted = formatObservationLog(store.observations);

  const lines: string[] = [
    `# MABOS Observations — ${agentId}`,
    "",
    `> Auto-materialized from observation-log.json. ${store.observations.length} observations.`,
    `> Messages compressed: ${store.total_messages_compressed ?? 0}. Tool calls compressed: ${store.total_tool_calls_compressed ?? 0}.`,
    "",
    formatted,
  ];

  await writeMd(outPath, lines.join("\n"));
}

/**
 * Run all materializers in parallel. Failures are non-fatal.
 */
export async function materializeAll(api: OpenClawPluginApi, agentId: string): Promise<void> {
  await Promise.all([
    materializeFacts(api, agentId).catch(() => {}),
    materializeBeliefs(api, agentId).catch(() => {}),
    materializeMemoryItems(api, agentId).catch(() => {}),
    materializeObservations(api, agentId).catch(() => {}),
  ]);
}
