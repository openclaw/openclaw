/**
 * Aggregation engine: query usage data by tool, skill, day, date range.
 */

import { aggregateSkillSessions, type SkillSessionHealth } from "./skill-session.js";
import type { UsageRecord, UsageStorage, SkillSessionStorage } from "./storage.js";

export type QueryParams = {
  startDay?: string; // YYYY-MM-DD
  endDay?: string; // YYYY-MM-DD
  tool?: string;
  skill?: string;
  groupBy?: "tool" | "skill" | "day" | "agent";
};

export type AggregatedBucket = {
  key: string;
  count: number;
  errors: number;
  avgDurMs: number;
  totalDurMs: number;
  skills: string[];
};

export type QueryResult = {
  totalRecords: number;
  totalErrors: number;
  buckets: AggregatedBucket[];
  dateRange: { start: string; end: string };
};

export type SkillHealthEntry = {
  skill: string;
  totalCalls: number;
  entryReads: number;
  subReads: number;
  errors: number;
  avgDurMs: number;
};

export type StatusResult = {
  totalRecords: number;
  daysTracked: number;
  dateRange: { start: string; end: string } | null;
  topTools: Array<{ tool: string; count: number }>;
  topSkills: Array<{ skill: string; count: number }>;
};

function todayKey(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysAgoKey(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayKeyFromTs(ts: number): string {
  const d = new Date(ts * 1000);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Run an aggregation query against the usage storage.
 */
export async function queryUsage(storage: UsageStorage, params: QueryParams): Promise<QueryResult> {
  const startDay = params.startDay ?? daysAgoKey(30);
  const endDay = params.endDay ?? todayKey();
  const groupBy = params.groupBy ?? "tool";

  const records = await storage.readRange(startDay, endDay);

  // Apply filters
  const filtered = records.filter((r) => {
    if (params.tool && r.tool !== params.tool) return false;
    if (params.skill && r.skill !== params.skill) return false;
    return true;
  });

  // Group into buckets
  const bucketMap = new Map<string, { records: UsageRecord[] }>();
  for (const r of filtered) {
    let key: string;
    switch (groupBy) {
      case "tool":
        key = r.tool;
        break;
      case "skill":
        key = r.skill ?? "(none)";
        break;
      case "day":
        key = dayKeyFromTs(r.ts);
        break;
      case "agent":
        key = r.agent ?? "(unknown)";
        break;
      default:
        key = r.tool;
    }
    const bucket = bucketMap.get(key) ?? { records: [] };
    bucket.records.push(r);
    bucketMap.set(key, bucket);
  }

  const buckets: AggregatedBucket[] = [];
  for (const [key, bucket] of bucketMap) {
    const errors = bucket.records.filter((r) => r.err).length;
    const durations = bucket.records.filter((r) => r.dur != null).map((r) => r.dur!);
    const totalDurMs = durations.reduce((sum, d) => sum + d, 0);
    const avgDurMs = durations.length > 0 ? totalDurMs / durations.length : 0;
    const skills = [...new Set(bucket.records.filter((r) => r.skill).map((r) => r.skill!))];

    buckets.push({
      key,
      count: bucket.records.length,
      errors,
      avgDurMs: Math.round(avgDurMs),
      totalDurMs,
      skills,
    });
  }

  // Sort by count descending
  buckets.sort((a, b) => b.count - a.count);

  return {
    totalRecords: filtered.length,
    totalErrors: filtered.filter((r) => r.err).length,
    buckets,
    dateRange: { start: startDay, end: endDay },
  };
}

/**
 * Get skill health metrics — aggregated per-skill breakdown.
 */
export async function querySkillHealth(
  storage: UsageStorage,
  params: { startDay?: string; endDay?: string },
): Promise<SkillHealthEntry[]> {
  const startDay = params.startDay ?? daysAgoKey(30);
  const endDay = params.endDay ?? todayKey();

  const records = await storage.readRange(startDay, endDay);
  const skillRecords = records.filter((r) => r.skill);

  const skillMap = new Map<string, UsageRecord[]>();
  for (const r of skillRecords) {
    const list = skillMap.get(r.skill!) ?? [];
    list.push(r);
    skillMap.set(r.skill!, list);
  }

  const entries: SkillHealthEntry[] = [];
  for (const [skill, recs] of skillMap) {
    const errors = recs.filter((r) => r.err).length;
    const durations = recs.filter((r) => r.dur != null).map((r) => r.dur!);
    const avgDurMs =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    entries.push({
      skill,
      totalCalls: recs.length,
      entryReads: recs.filter((r) => r.skillType === "entry").length,
      subReads: recs.filter((r) => r.skillType === "sub").length,
      errors,
      avgDurMs: Math.round(avgDurMs),
    });
  }

  entries.sort((a, b) => b.totalCalls - a.totalCalls);
  return entries;
}

/**
 * Get high-level status overview.
 */
export async function queryStatus(storage: UsageStorage): Promise<StatusResult> {
  const days = storage.listDays();
  if (days.length === 0) {
    return {
      totalRecords: 0,
      daysTracked: 0,
      dateRange: null,
      topTools: [],
      topSkills: [],
    };
  }

  const startDay = days[0];
  const endDay = days[days.length - 1];
  const records = await storage.readRange(startDay, endDay);

  // Top tools
  const toolCounts = new Map<string, number>();
  for (const r of records) {
    toolCounts.set(r.tool, (toolCounts.get(r.tool) ?? 0) + 1);
  }
  const topTools = [...toolCounts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Top skills
  const skillCounts = new Map<string, number>();
  for (const r of records) {
    if (r.skill) {
      skillCounts.set(r.skill, (skillCounts.get(r.skill) ?? 0) + 1);
    }
  }
  const topSkills = [...skillCounts.entries()]
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalRecords: records.length,
    daysTracked: days.length,
    dateRange: { start: startDay, end: endDay },
    topTools,
    topSkills,
  };
}

// ── Skill Session queries ──────────────────────────────────────────────

export async function querySkillSessions(
  skillSessionStorage: SkillSessionStorage,
): Promise<SkillSessionHealth[]> {
  const records = await skillSessionStorage.readAll();

  // Convert storage records to SkillSession type
  const sessions = records.map((r) => ({
    skill: r.skill,
    startTs: r.startTs,
    endTs: r.endTs,
    durationSec: r.durationSec,
    toolCalls: r.toolCalls,
    toolBreakdown: r.toolBreakdown,
    subReads: r.subReads,
    endReason: r.endReason as "text_response" | "user_msg" | "different_skill" | "eof",
    sessionKey: r.session,
    agent: r.agent,
  }));

  return aggregateSkillSessions(sessions);
}
