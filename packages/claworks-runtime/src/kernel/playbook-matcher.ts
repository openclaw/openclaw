import type { PlaybookDefinition } from "../planes/orch/playbook-types.js";
import { matchGlob } from "./glob.js";
import type { CwEvent, CwEventMatch, EventTrigger } from "./types.js";

export interface PlaybookMatcher {
  load(playbooks: PlaybookDefinition[]): void;
  match(event: CwEvent): CwEventMatch[];
}

export function createPlaybookMatcher(): PlaybookMatcher {
  let rules: Array<{ playbookId: string; trigger: EventTrigger; priority: number }> = [];

  return {
    load(playbooks: PlaybookDefinition[]) {
      rules = playbooks
        .filter((p) => p.trigger.kind === "event")
        .map((p) => ({
          playbookId: p.id,
          trigger: p.trigger,
          priority: p.priority,
        }));
    },

    match(event: CwEvent): CwEventMatch[] {
      const matches: CwEventMatch[] = [];
      const semanticCandidates: CwEventMatch[] = [];

      for (const rule of rules) {
        if (rule.trigger.kind !== "event") {
          continue;
        }
        const globHit = matchGlob(rule.trigger.pattern, event.type);
        const semanticHit =
          !globHit && semanticFallbackScore(rule.trigger.pattern, event.type) >= 0.5;
        if (!globHit && !semanticHit) {
          continue;
        }
        if (rule.trigger.filter && !matchesFilter(rule.trigger.filter, event.payload)) {
          continue;
        }
        if (rule.trigger.condition && !evaluateCondition(rule.trigger.condition, event.payload)) {
          continue;
        }
        const entry: CwEventMatch = {
          event,
          playbookId: rule.playbookId,
          priority: rule.priority,
          input: { ...event.payload, _event: event },
        };
        if (globHit) {
          matches.push(entry);
        } else {
          semanticCandidates.push(entry);
        }
      }

      if (matches.length === 0 && semanticCandidates.length > 0) {
        semanticCandidates.sort((a, b) => b.priority - a.priority);
        matches.push(semanticCandidates[0]!);
      }

      matches.sort((a, b) => b.priority - a.priority);
      return matches;
    },
  };
}

/** Token overlap fallback when glob patterns miss (e.g. alarm.triggered ≈ alarm.created). */
export function semanticFallbackScore(pattern: string, eventType: string): number {
  const a = tokenizeEventKey(pattern);
  const b = tokenizeEventKey(eventType);
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const t of a) {
    if (b.has(t)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(a.size, b.size);
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
