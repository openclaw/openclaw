/**
 * Global Search Hook — Cross-domain search across sessions, agents, goals,
 * decisions, cron jobs, and memories.
 *
 * Provides fuzzy-matched results with category grouping, keyboard navigation,
 * and route-aware navigation to search results.
 */

import { useMemo } from "react";
import { useAgents } from "./queries/useAgents";
import { useSessions } from "./queries/useSessions";
import { useGoals, type Goal } from "./queries/useGoals";
import { useCronJobs } from "./queries/useCron";
import type { CronJob } from "./queries/useCron";
import { useDecisions } from "./queries/useDecisions";
import type { DecisionAuditEntry } from "@/components/domain/decisions/decision-types";
import { useDebounce } from "./useDebounce";

// ─── Types ──────────────────────────────────────────────────────

export type SearchCategory =
  | "agent"
  | "session"
  | "goal"
  | "decision"
  | "cron"
  | "memory"
  | "navigation";

export interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
  category: SearchCategory;
  icon?: string;
  /** Route to navigate to when selected */
  route?: string;
  /** Match score (0-1, higher is better) */
  score: number;
  /** Raw data for extra context */
  meta?: Record<string, unknown>;
}

export interface GlobalSearchOptions {
  /** Maximum results per category */
  maxPerCategory?: number;
  /** Total max results */
  maxTotal?: number;
  /** Categories to search (default: all) */
  categories?: SearchCategory[];
  /** Debounce delay in ms (default: 200) */
  debounceMs?: number;
}

// ─── Fuzzy Matching ─────────────────────────────────────────────

/**
 * Simple fuzzy match scoring. Returns a score between 0 and 1.
 * Higher score = better match.
 *
 * Supports:
 * - Exact substring match (highest score)
 * - Word-prefix matching
 * - Character-sequence matching (fuzzy)
 */
export function fuzzyMatch(query: string, text: string): number {
  if (!query || !text) return 0;

  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact match
  if (t === q) return 1.0;

  // Starts with query
  if (t.startsWith(q)) return 0.95;

  // Contains exact substring
  const substringIdx = t.indexOf(q);
  if (substringIdx !== -1) {
    // Closer to start = better score
    return 0.85 - substringIdx * 0.005;
  }

  // Word-prefix matching: check if query matches start of any word
  const words = t.split(/[\s\-_./]+/);
  for (const word of words) {
    if (word.startsWith(q)) return 0.75;
  }

  // Multi-word query: check if all query words match some word prefix
  const queryWords = q.split(/\s+/);
  if (queryWords.length > 1) {
    const allMatch = queryWords.every((qw) =>
      words.some((w) => w.startsWith(qw) || w.includes(qw)),
    );
    if (allMatch) return 0.7;
  }

  // Character-sequence matching (fuzzy)
  let qi = 0;
  let consecutive = 0;
  let maxConsecutive = 0;
  let prevMatchIdx = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (ti === prevMatchIdx + 1) {
        consecutive++;
        maxConsecutive = Math.max(maxConsecutive, consecutive);
      } else {
        consecutive = 1;
      }
      prevMatchIdx = ti;
      qi++;
    }
  }

  // All chars matched?
  if (qi === q.length) {
    const charRatio = q.length / t.length;
    const consecutiveBonus = maxConsecutive / q.length;
    return Math.min(0.6, 0.3 + charRatio * 0.15 + consecutiveBonus * 0.15);
  }

  return 0;
}

/**
 * Match query against multiple fields, returning the best score.
 */
function matchFields(query: string, fields: (string | undefined)[]): number {
  let best = 0;
  for (const field of fields) {
    if (field) {
      const score = fuzzyMatch(query, field);
      if (score > best) best = score;
    }
  }
  return best;
}

// ─── Search Providers ───────────────────────────────────────────

function searchAgents(
  query: string,
  agents: Array<{ id: string; name: string; role?: string; model?: string; status?: string; description?: string }>,
  max: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const agent of agents) {
    const score = matchFields(query, [agent.name, agent.role, agent.model, agent.description, agent.id]);
    if (score > 0.2) {
      results.push({
        id: `agent:${agent.id}`,
        title: agent.name,
        subtitle: [agent.role, agent.status].filter(Boolean).join(" · "),
        category: "agent",
        route: `/agents/${agent.id}`,
        score,
        meta: { agentId: agent.id, status: agent.status },
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, max);
}

function searchSessions(
  query: string,
  sessions: Array<{ key: string; label?: string; derivedTitle?: string; lastMessage?: string }>,
  max: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const session of sessions) {
    const displayName = session.label || session.derivedTitle || session.key;
    const score = matchFields(query, [displayName, session.key, session.lastMessage]);
    if (score > 0.2) {
      results.push({
        id: `session:${session.key}`,
        title: displayName,
        subtitle: session.lastMessage?.slice(0, 80),
        category: "session",
        route: `/conversations?session=${encodeURIComponent(session.key)}`,
        score,
        meta: { sessionKey: session.key },
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, max);
}

function searchGoals(
  query: string,
  goals: Goal[],
  max: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const goal of goals) {
    const tagsStr = goal.tags?.join(" ") ?? "";
    const score = matchFields(query, [goal.title, goal.description, tagsStr, goal.status]);
    if (score > 0.2) {
      results.push({
        id: `goal:${goal.id}`,
        title: goal.title,
        subtitle: `${goal.status} · ${goal.progress}%`,
        category: "goal",
        route: `/goals/${goal.id}`,
        score,
        meta: { goalId: goal.id, status: goal.status, progress: goal.progress },
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, max);
}

function searchDecisions(
  query: string,
  decisions: DecisionAuditEntry[],
  max: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const decision of decisions) {
    const score = matchFields(query, [
      decision.title,
      decision.question,
      decision.reasoning,
      decision.goalId,
      decision.outcome,
      decision.agentId,
    ]);
    if (score > 0.2) {
      results.push({
        id: `decision:${decision.id}`,
        title: decision.title ?? `Decision ${decision.id.slice(0, 8)}`,
        subtitle: decision.outcome
          ? `${decision.outcome} · ${new Date(decision.timestamp).toLocaleDateString()}`
          : new Date(decision.timestamp).toLocaleDateString(),
        category: "decision",
        route: `/decisions?id=${decision.id}`,
        score,
        meta: { decisionId: decision.id },
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, max);
}

function searchCronJobs(
  query: string,
  jobs: CronJob[],
  max: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const job of jobs) {
    const score = matchFields(query, [job.name ?? job.id, job.id]);
    if (score > 0.2) {
      results.push({
        id: `cron:${job.id}`,
        title: job.name ?? job.id,
        subtitle: job.enabled ? "Enabled" : "Disabled",
        category: "cron",
        route: `/jobs/${job.id}`,
        score,
        meta: { cronId: job.id, enabled: job.enabled },
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, max);
}

// Static navigation items for quick access
const NAVIGATION_ITEMS: SearchResult[] = [
  { id: "nav:home", title: "Home", subtitle: "Dashboard overview", category: "navigation", route: "/", score: 0 },
  { id: "nav:agents", title: "Agents", subtitle: "Manage AI agents", category: "navigation", route: "/agents", score: 0 },
  { id: "nav:conversations", title: "Conversations", subtitle: "Chat sessions", category: "navigation", route: "/conversations", score: 0 },
  { id: "nav:goals", title: "Goals", subtitle: "Autonomous workflows", category: "navigation", route: "/goals", score: 0 },
  { id: "nav:workstreams", title: "Workstreams", subtitle: "Task management", category: "navigation", route: "/workstreams", score: 0 },
  { id: "nav:decisions", title: "Decisions", subtitle: "Audit log", category: "navigation", route: "/decisions", score: 0 },
  { id: "nav:memories", title: "Memories", subtitle: "Knowledge base", category: "navigation", route: "/memories", score: 0 },
  { id: "nav:rituals", title: "Rituals", subtitle: "Recurring patterns", category: "navigation", route: "/rituals", score: 0 },
  { id: "nav:jobs", title: "Cron Jobs", subtitle: "Scheduled tasks", category: "navigation", route: "/jobs", score: 0 },
  { id: "nav:nodes", title: "Nodes", subtitle: "Connected devices", category: "navigation", route: "/nodes", score: 0 },
  { id: "nav:settings", title: "Settings", subtitle: "Configuration", category: "navigation", route: "/settings", score: 0 },
  { id: "nav:debug", title: "Debug", subtitle: "Diagnostic tools", category: "navigation", route: "/debug", score: 0 },
];

function searchNavigation(query: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  for (const item of NAVIGATION_ITEMS) {
    const score = matchFields(query, [item.title, item.subtitle]);
    if (score > 0.2) {
      results.push({ ...item, score });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, max);
}

// ─── Category Metadata ──────────────────────────────────────────

export const CATEGORY_META: Record<SearchCategory, { label: string; icon: string; order: number }> = {
  navigation: { label: "Pages", icon: "🧭", order: 0 },
  agent: { label: "Agents", icon: "🤖", order: 1 },
  session: { label: "Sessions", icon: "💬", order: 2 },
  goal: { label: "Goals", icon: "🎯", order: 3 },
  decision: { label: "Decisions", icon: "⚖️", order: 4 },
  cron: { label: "Cron Jobs", icon: "⏰", order: 5 },
  memory: { label: "Memories", icon: "🧠", order: 6 },
};

// ─── Main Hook ──────────────────────────────────────────────────

export function useGlobalSearch(
  rawQuery: string,
  options: GlobalSearchOptions = {},
) {
  const {
    maxPerCategory = 5,
    maxTotal = 20,
    categories,
    debounceMs = 200,
  } = options;

  const query = useDebounce(rawQuery.trim(), debounceMs);

  // Data sources — pull from cached React Query data when available.
  // These hooks return { data, ... }, so we default to empty arrays.
  const agentsQuery = useAgents();
  const sessionsQuery = useSessions();
  const goalsQuery = useGoals();
  const cronJobsQuery = useCronJobs();
  const decisionsQuery = useDecisions();

  const agents = agentsQuery.data ?? [];
  // useSessions returns { data: SessionsListResult } with .sessions array
  const sessions = sessionsQuery.data?.sessions ?? [];
  const goals = goalsQuery.data ?? [];
  // useCronJobs returns { data: CronJobListResult } with .jobs array
  const cronJobs = cronJobsQuery.data?.jobs ?? [];
  const decisions = decisionsQuery.data ?? [];

  const results = useMemo(() => {
    if (!query || query.length < 2) return [];

    const enabledCategories = categories ? new Set(categories) : null;
    const allResults: SearchResult[] = [];

    // Search each category
    if (!enabledCategories || enabledCategories.has("navigation")) {
      allResults.push(...searchNavigation(query, maxPerCategory));
    }
    if (!enabledCategories || enabledCategories.has("agent")) {
      allResults.push(...searchAgents(query, agents, maxPerCategory));
    }
    if (!enabledCategories || enabledCategories.has("session")) {
      allResults.push(...searchSessions(query, sessions, maxPerCategory));
    }
    if (!enabledCategories || enabledCategories.has("goal")) {
      allResults.push(...searchGoals(query, goals, maxPerCategory));
    }
    if (!enabledCategories || enabledCategories.has("decision")) {
      allResults.push(...searchDecisions(query, decisions, maxPerCategory));
    }
    if (!enabledCategories || enabledCategories.has("cron")) {
      allResults.push(...searchCronJobs(query, cronJobs, maxPerCategory));
    }

    // Sort by score globally, then trim
    return allResults.sort((a, b) => b.score - a.score).slice(0, maxTotal);
  }, [query, agents, sessions, goals, decisions, cronJobs, maxPerCategory, maxTotal, categories]);

  // Group results by category (ordered by CATEGORY_META.order)
  const grouped = useMemo(() => {
    const groups = new Map<SearchCategory, SearchResult[]>();
    for (const result of results) {
      const group = groups.get(result.category) || [];
      group.push(result);
      groups.set(result.category, group);
    }
    // Sort groups by category order
    return Array.from(groups.entries())
      .sort(([a], [b]) => CATEGORY_META[a].order - CATEGORY_META[b].order)
      .map(([category, items]) => ({
        category,
        label: CATEGORY_META[category].label,
        icon: CATEGORY_META[category].icon,
        items,
      }));
  }, [results]);

  return {
    query,
    results,
    grouped,
    isEmpty: results.length === 0 && query.length >= 2,
    isSearching: query !== rawQuery.trim(),
    totalCount: results.length,
  };
}
