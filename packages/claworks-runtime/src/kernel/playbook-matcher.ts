import type { PlaybookDefinition } from "../planes/orch/playbook-types.js";
import { matchGlob } from "./glob.js";
import type { CwEvent, CwEventMatch, EventTrigger } from "./types.js";

export interface PlaybookMatcher {
  load(playbooks: PlaybookDefinition[]): void;
  match(event: CwEvent): CwEventMatch[];
}

type RuleEntry = { playbookId: string; trigger: EventTrigger; priority: number };

export function createPlaybookMatcher(): PlaybookMatcher {
  let rules: RuleEntry[] = [];
  /**
   * 精确匹配索引：eventType → 规则列表（无通配符 pattern 才入索引）。
   * 热路径从 O(n) 全量遍历降为 O(1) + 少量通配符扫描。
   * 语义回退（semantic fallback）仍需扫描全量规则，但仅在无 glob 命中时执行。
   */
  const exactIndex = new Map<string, RuleEntry[]>();
  let wildcardRules: RuleEntry[] = [];

  function buildIndex(newRules: RuleEntry[]): void {
    exactIndex.clear();
    wildcardRules = [];
    for (const rule of newRules) {
      if (rule.trigger.kind !== "event") {
        continue;
      }
      const p = rule.trigger.pattern;
      if (!p.includes("*") && !p.includes("?")) {
        const bucket = exactIndex.get(p);
        if (bucket) {
          bucket.push(rule);
        } else {
          exactIndex.set(p, [rule]);
        }
      } else {
        wildcardRules.push(rule);
      }
    }
  }

  return {
    load(playbooks: PlaybookDefinition[]) {
      rules = playbooks
        .filter((p) => p.trigger.kind === "event")
        .map((p) => ({
          playbookId: p.id,
          trigger: p.trigger,
          priority: p.priority,
        }));
      buildIndex(rules);
    },

    match(event: CwEvent): CwEventMatch[] {
      const matches: CwEventMatch[] = [];
      const semanticCandidates: CwEventMatch[] = [];

      // 精确命中（O(1) 查找）+ 通配符扫描
      const exactHits = exactIndex.get(event.type) ?? [];
      const exactHitSet = new Set(exactHits);

      // 热路径：精确匹配 + 通配符规则
      const hotCandidates = exactHits.length > 0 ? [...exactHits, ...wildcardRules] : wildcardRules;

      for (const rule of hotCandidates) {
        if (rule.trigger.kind !== "event") {
          continue;
        }
        const globHit = exactHitSet.has(rule) || matchGlob(rule.trigger.pattern, event.type);
        if (!globHit) {
          continue;
        }
        if (rule.trigger.filter && !matchesFilter(rule.trigger.filter, event.payload)) {
          continue;
        }
        if (rule.trigger.condition && !evaluateCondition(rule.trigger.condition, event.payload)) {
          continue;
        }
        matches.push({
          event,
          playbookId: rule.playbookId,
          priority: rule.priority,
          input: { ...event.payload, _event: event },
        });
      }

      // 语义回退：仅在无 glob 命中时，扫描全量规则寻找语义近似匹配
      if (matches.length === 0) {
        for (const rule of rules) {
          if (rule.trigger.kind !== "event") {
            continue;
          }
          if (matchGlob(rule.trigger.pattern, event.type)) {
            continue;
          } // 已被热路径处理
          const score = semanticFallbackScore(rule.trigger.pattern, event.type);
          if (score < 0.5) {
            continue;
          }
          if (rule.trigger.filter && !matchesFilter(rule.trigger.filter, event.payload)) {
            continue;
          }
          if (rule.trigger.condition && !evaluateCondition(rule.trigger.condition, event.payload)) {
            continue;
          }
          semanticCandidates.push({
            event,
            playbookId: rule.playbookId,
            priority: rule.priority,
            input: { ...event.payload, _event: event },
          });
        }
        if (semanticCandidates.length > 0) {
          semanticCandidates.sort((a, b) => b.priority - a.priority);
          matches.push(semanticCandidates[0]);
        }
      }

      matches.sort((a, b) => b.priority - a.priority);
      return matches;
    },
  };
}

/**
 * Token overlap fallback when glob patterns miss (e.g. equipment.alarm ≈ equipment.alarm.tripped).
 * Pattern tokens must all appear in the event type so sibling evolution events
 * (simulation_requested vs regression_requested) do not cross-match.
 */
export function semanticFallbackScore(pattern: string, eventType: string): number {
  const a = tokenizeEventKey(pattern);
  const b = tokenizeEventKey(eventType);
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  for (const t of a) {
    if (!b.has(t)) {
      return 0;
    }
  }
  return a.size / Math.max(a.size, b.size);
}

function tokenizeEventKey(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[.*_\-/]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1 && s !== "*"),
  );
}

function matchesFilter(filter: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (payload[key] !== expected) {
      return false;
    }
  }
  return true;
}

/** Best-effort translation of Python-style pack conditions. */
export function evaluateCondition(condition: string, payload: Record<string, unknown>): boolean {
  const trimmed = condition.trim();
  const inList = trimmed.match(
    /payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)\s+in\s+\(([^)]+)\)/,
  );
  if (inList) {
    const value = String(payload[inList[1]] ?? "");
    const options = inList[2]
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    return options.includes(value);
  }

  if (trimmed.includes(" and ")) {
    const parts = trimmed.split(/\s+and\s+/);
    return parts.every((part) => evaluateCondition(part.trim(), payload));
  }

  const getMatch = trimmed.match(/payload\.get\(\s*['"](\w+)['"]\s*(?:,\s*[^)]+)?\s*\)/);
  if (getMatch) {
    const key = getMatch[1];
    if (trimmed.startsWith("bool(") || trimmed.includes("bool(payload")) {
      return Boolean(payload[key]);
    }
    return payload[key] != null;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return true;
}
