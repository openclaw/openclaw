/**
 * Temporal Reasoning Tool
 *
 * Hybrid tool that combines algorithmic analysis (topological sort,
 * cycle detection, critical path) with LLM-based qualitative reasoning
 * about time-dependent event sequences.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const EventSchema = Type.Object({
  id: Type.String({ description: "Unique event identifier" }),
  label: Type.String({ description: "Human-readable event label" }),
  timestamp: Type.Optional(
    Type.String({ description: "ISO-8601 timestamp or relative time marker" }),
  ),
  depends_on: Type.Optional(
    Type.Array(Type.String(), { description: "IDs of events this event depends on" }),
  ),
});

const TemporalParams = Type.Object({
  events: Type.Array(EventSchema, {
    description: "Events with optional timestamps and dependency edges",
  }),
  query: Type.String({ description: "Question to answer about the temporal structure" }),
  analysis_type: Type.Union(
    [Type.Literal("ordering"), Type.Literal("critical_path"), Type.Literal("dependencies")],
    { description: "Type of temporal analysis: ordering, critical_path, or dependencies" },
  ),
});

/* ------------------------------------------------------------------ */
/*  Algorithmic helpers                                                */
/* ------------------------------------------------------------------ */

interface TopoResult {
  order: string[];
  hasCycle: boolean;
  cycleMembers: string[];
}

/**
 * Kahn's algorithm (BFS-based topological sort).
 * Returns the sorted order, or reports a cycle.
 */
function topologicalSort(nodeIds: string[], adj: Map<string, string[]>): TopoResult {
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) inDegree.set(id, 0);

  for (const [, targets] of adj) {
    for (const t of targets) {
      inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (order.length === nodeIds.length) {
    return { order, hasCycle: false, cycleMembers: [] };
  }

  // Nodes not in `order` are involved in a cycle
  const sorted = new Set(order);
  const cycleMembers = nodeIds.filter((id) => !sorted.has(id));
  return { order, hasCycle: true, cycleMembers };
}

/**
 * Compute durations between dependent events when timestamps are available.
 */
function computeDurations(events: Static<typeof TemporalParams>["events"]): string[] {
  const tsMap = new Map<string, number>();
  const labelMap = new Map<string, string>();

  for (const ev of events) {
    labelMap.set(ev.id, ev.label);
    if (ev.timestamp) {
      const ms = Date.parse(ev.timestamp);
      if (!Number.isNaN(ms)) tsMap.set(ev.id, ms);
    }
  }

  const lines: string[] = [];
  for (const ev of events) {
    if (!ev.depends_on?.length) continue;
    const evTs = tsMap.get(ev.id);
    if (evTs === undefined) continue;

    for (const depId of ev.depends_on) {
      const depTs = tsMap.get(depId);
      if (depTs === undefined) continue;
      const diffMs = evTs - depTs;
      const diffHours = (diffMs / 3_600_000).toFixed(2);
      lines.push(`  ${labelMap.get(depId) ?? depId} -> ${ev.label}: ${diffHours} h (${diffMs} ms)`);
    }
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/*  Tool factory                                                       */
/* ------------------------------------------------------------------ */

export function createTemporalTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_temporal",
    label: "Temporal Reasoning",
    description:
      "Analyze time-dependent event sequences: compute topological ordering, detect cycles, find critical paths, and reason qualitatively about temporal dependencies.",
    parameters: TemporalParams,
    async execute(_id: string, params: Static<typeof TemporalParams>) {
      const { events, query, analysis_type } = params;

      // Build adjacency list (dependency -> dependent, i.e., dep must come before event)
      const nodeIds = events.map((e) => e.id);
      const nodeIdSet = new Set(nodeIds);
      const adj = new Map<string, string[]>();
      for (const id of nodeIds) adj.set(id, []);

      const unknownDeps: string[] = [];
      for (const ev of events) {
        for (const dep of ev.depends_on ?? []) {
          if (!nodeIdSet.has(dep)) {
            unknownDeps.push(`${ev.id} depends on unknown "${dep}"`);
            continue;
          }
          adj.get(dep)!.push(ev.id);
        }
      }

      // Topological sort
      const topo = topologicalSort(nodeIds, adj);

      // Label lookup
      const labelOf = new Map<string, string>();
      for (const ev of events) labelOf.set(ev.id, ev.label);

      // --- Build algorithmic results section ---
      const sections: string[] = [];

      if (unknownDeps.length) {
        sections.push(`**Warnings:**\n${unknownDeps.map((w) => `- ${w}`).join("\n")}`);
      }

      if (topo.hasCycle) {
        const cycleLabels = topo.cycleMembers.map((id) => labelOf.get(id) ?? id);
        sections.push(
          `**Cycle detected** among: ${cycleLabels.join(", ")}\n\nA valid topological ordering is not possible for the full graph. Partial order (acyclic subset):\n${topo.order.map((id, i) => `  ${i + 1}. ${labelOf.get(id) ?? id}`).join("\n")}`,
        );
      } else {
        sections.push(
          `**Topological Order:**\n${topo.order.map((id, i) => `  ${i + 1}. ${labelOf.get(id) ?? id}`).join("\n")}`,
        );
      }

      // Durations
      const durations = computeDurations(events);
      if (durations.length) {
        sections.push(`**Durations between dependent events:**\n${durations.join("\n")}`);
      }

      // Dependency summary
      const depSummary = events
        .filter((e) => e.depends_on?.length)
        .map(
          (e) =>
            `  ${e.label} depends on: ${e.depends_on!.map((d) => labelOf.get(d) ?? d).join(", ")}`,
        );
      if (depSummary.length) {
        sections.push(`**Dependency Map:**\n${depSummary.join("\n")}`);
      }

      // --- Analysis-type-specific qualitative prompt ---
      let qualitativePrompt: string;
      switch (analysis_type) {
        case "ordering":
          qualitativePrompt = `Using the computed topological order above, reason about:
1. Is this the only valid ordering, or are there events that could be reordered?
2. Which events are independent and could run in parallel?
3. Are there any surprising ordering constraints?`;
          break;
        case "critical_path":
          qualitativePrompt = `Using the computed ordering and durations above, determine:
1. Which sequence of dependent events forms the longest (critical) path?
2. What is the total duration along the critical path?
3. Which events have slack (could be delayed without affecting the overall timeline)?
4. What are the bottleneck events?`;
          break;
        case "dependencies":
          qualitativePrompt = `Using the dependency map above, analyze:
1. Which events are root causes (no dependencies)?
2. Which events are terminal outcomes (nothing depends on them)?
3. Are there hub events that many others depend on?
4. How fragile is the dependency structure — single points of failure?`;
          break;
      }

      return textResult(`## Temporal Analysis — ${analysis_type}

**Query:** ${query}

**Events (${events.length}):**
${events.map((e) => `  - ${e.label} [${e.id}]${e.timestamp ? ` @ ${e.timestamp}` : ""}`).join("\n")}

---

### Computed Results

${sections.join("\n\n")}

---

### Qualitative Analysis

${qualitativePrompt}

Provide a structured answer to the query: "${query}"`);
    },
  };
}
