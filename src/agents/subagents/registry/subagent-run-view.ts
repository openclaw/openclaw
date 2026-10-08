/** Canonical ordering and visibility for numbered subagent lists and targets. */
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isRetainedUnendedSubagentRun, isYieldedSubagentRun } from "./subagent-run-liveness.js";
import { isSubagentChildStopUnconfirmed } from "./subagent-session-metrics.js";

/** Keep display indices and command targets on the same latest-run/liveness policy. */
export function buildSubagentRunView(params: {
  runs: readonly SubagentRunRecord[];
  recentMinutes: number;
  countPendingDescendantRuns: (sessionKey: string) => number;
  now?: number;
}) {
  const now = params.now ?? Date.now();
  const recentCutoff = now - params.recentMinutes * 60_000;
  const latest: SubagentRunRecord[] = [];
  const active: SubagentRunRecord[] = [];
  const recent: SubagentRunRecord[] = [];
  const seen = new Map<string, SubagentRunRecord[]>();
  for (const entry of params.runs.toSorted((a, b) => {
    const aTime = a.execution.startedAt ?? a.createdAt;
    const bTime = b.execution.startedAt ?? b.createdAt;
    return bTime - aTime;
  })) {
    const childRuns = seen.get(entry.childSessionKey) ?? [];
    const superseded = childRuns.some((candidate) =>
      matchesSubagentChildSessionOwner(candidate, entry.childSessionKey, entry.childAgentId),
    );
    // Hidden legacy rows still fence every older owner under the raw key.
    childRuns.push(entry);
    seen.set(entry.childSessionKey, childRuns);
    if (superseded) {
      continue;
    }
    latest.push(entry);
    if (
      isRetainedUnendedSubagentRun(entry, now) ||
      // Legacy expiry rows may carry provisional endedAt; newer observations
      // may outlive the unended liveness window. Neither proves a child stop.
      // Keep them visible for re-observation, not alongside confirmed endings.
      isSubagentChildStopUnconfirmed(entry) ||
      isYieldedSubagentRun(entry) ||
      params.countPendingDescendantRuns(entry.childSessionKey) > 0
    ) {
      active.push(entry);
    } else if (entry.execution.endedAt && entry.execution.endedAt >= recentCutoff) {
      recent.push(entry);
    }
  }
  return { latest, active, recent };
}
