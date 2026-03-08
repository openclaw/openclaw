/**
 * Skill Session tracking.
 *
 * A "skill session" is the full lifecycle from reading a SKILL.md to the agent
 * delivering a final text response. It captures:
 * - Total wall-clock duration
 * - All tool calls made while the skill was "active"
 * - Sub-file reads within the skill directory
 * - How the session ended (text response, user message, different skill, eof)
 */

export type SkillSession = {
  skill: string;
  startTs: number; // seconds epoch
  endTs: number; // seconds epoch
  durationSec: number; // wall-clock seconds
  toolCalls: number; // total tool calls during this session
  toolBreakdown: Record<string, number>; // tool name → count
  subReads: number; // sub-file reads within the skill directory
  endReason: "text_response" | "user_msg" | "different_skill" | "eof";
  sessionKey?: string;
  agent?: string;
};

/**
 * Extract skill sessions from a chronologically-ordered list of transcript entries.
 * Each entry represents one message (user/assistant/toolResult).
 */
export type TranscriptEntry = {
  tsMs: number; // millisecond epoch
  role: string; // user | assistant | toolResult | tool
  toolCalls: Array<{ name: string; path?: string }>;
  hasTextResponse: boolean; // assistant message with substantial text, no tool calls
  skillEntry?: string; // skill name if this entry reads a SKILL.md
  skillSubRead?: string; // skill name if this entry reads a skill sub-file
};

export function extractSkillSessions(entries: TranscriptEntry[]): SkillSession[] {
  const sessions: SkillSession[] = [];
  let i = 0;

  while (i < entries.length) {
    const e = entries[i];

    // Look for skill entry point (SKILL.md read)
    if (!e.skillEntry) {
      i++;
      continue;
    }

    const skillName = e.skillEntry;
    const startTs = e.tsMs;
    const toolBreakdown: Record<string, number> = {};
    let toolCalls = 0;
    let subReads = 0;
    let endTs = startTs;
    let endReason: SkillSession["endReason"] = "eof";

    // Count the initial entry's tool calls
    for (const tc of e.toolCalls) {
      toolBreakdown[tc.name] = (toolBreakdown[tc.name] ?? 0) + 1;
      toolCalls++;
    }

    // Trace forward
    let j = i + 1;
    while (j < entries.length) {
      const ej = entries[j];
      const ejTs = ej.tsMs || endTs;

      // User message → skill session ended
      if (ej.role === "user") {
        endReason = "user_msg";
        break;
      }

      // Different skill entry → this skill session ended
      if (ej.skillEntry && ej.skillEntry !== skillName) {
        endReason = "different_skill";
        break;
      }

      // Count tool calls
      for (const tc of ej.toolCalls) {
        toolBreakdown[tc.name] = (toolBreakdown[tc.name] ?? 0) + 1;
        toolCalls++;
      }

      // Count sub-reads for this skill
      if (ej.skillSubRead === skillName) {
        subReads++;
      }

      endTs = ejTs;

      // Assistant text response with no tool calls → likely the final answer
      // But only if the NEXT entry is a user message or eof
      if (ej.hasTextResponse && ej.toolCalls.length === 0 && ej.role === "assistant") {
        const next = j + 1 < entries.length ? entries[j + 1] : null;
        if (!next || next.role === "user") {
          endReason = "text_response";
          break;
        }
      }

      j++;
    }

    const durationSec = startTs && endTs ? Math.max(0, (endTs - startTs) / 1000) : 0;

    sessions.push({
      skill: skillName,
      startTs: Math.floor(startTs / 1000),
      endTs: Math.floor(endTs / 1000),
      durationSec: Math.round(durationSec * 10) / 10,
      toolCalls,
      toolBreakdown,
      subReads,
      endReason,
    });

    // Move past this skill session
    i = j;
  }

  return sessions;
}

/**
 * Aggregate skill sessions into per-skill health metrics.
 */
export type SkillSessionHealth = {
  skill: string;
  sessionCount: number;
  avgDurationSec: number;
  maxDurationSec: number;
  minDurationSec: number;
  avgToolCalls: number;
  avgSubReads: number;
  totalToolCalls: number;
  topTools: Array<{ tool: string; count: number }>;
  endReasons: Record<string, number>;
};

export function aggregateSkillSessions(sessions: SkillSession[]): SkillSessionHealth[] {
  const bySkill = new Map<string, SkillSession[]>();
  for (const s of sessions) {
    const list = bySkill.get(s.skill) ?? [];
    list.push(s);
    bySkill.set(s.skill, list);
  }

  const result: SkillSessionHealth[] = [];
  for (const [skill, ss] of bySkill) {
    const n = ss.length;
    const durations = ss.map((s) => s.durationSec);
    const totalTools = ss.reduce((sum, s) => sum + s.toolCalls, 0);
    const totalSubs = ss.reduce((sum, s) => sum + s.subReads, 0);

    // Aggregate tool breakdown
    const toolTotals = new Map<string, number>();
    for (const s of ss) {
      for (const [tool, count] of Object.entries(s.toolBreakdown)) {
        toolTotals.set(tool, (toolTotals.get(tool) ?? 0) + count);
      }
    }
    const topTools = [...toolTotals.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // End reasons
    const endReasons: Record<string, number> = {};
    for (const s of ss) {
      endReasons[s.endReason] = (endReasons[s.endReason] ?? 0) + 1;
    }

    result.push({
      skill,
      sessionCount: n,
      avgDurationSec: Math.round((durations.reduce((a, b) => a + b, 0) / n) * 10) / 10,
      maxDurationSec: Math.max(...durations),
      minDurationSec: Math.min(...durations),
      avgToolCalls: Math.round((totalTools / n) * 10) / 10,
      avgSubReads: Math.round((totalSubs / n) * 10) / 10,
      totalToolCalls: totalTools,
      topTools,
      endReasons,
    });
  }

  result.sort((a, b) => b.sessionCount - a.sessionCount);
  return result;
}
