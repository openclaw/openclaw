import type { Node, Edge } from "@xyflow/react";
import type { AgentListItem } from "./types";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;
const HORIZONTAL_GAP = 40;
const VERTICAL_GAP = 100;

// C-suite agent IDs that report directly to CEO
const C_SUITE_IDS = new Set(["cfo", "cmo", "coo", "cto"]);

// Map domain agents to their C-suite supervisor
const DEPARTMENT_MAP: Record<string, string> = {
  // COO's reports
  inventory: "coo",
  "inventory-mgr": "coo",
  fulfillment: "coo",
  "fulfillment-mgr": "coo",
  hr: "coo",
  // CTO's reports
  product: "cto",
  "product-mgr": "cto",
  knowledge: "cto",
  // CMO's reports
  marketing: "cmo",
  "marketing-dir": "cmo",
  sales: "cmo",
  "sales-dir": "cmo",
  creative: "cmo",
  "creative-dir": "cmo",
  cs: "cmo",
  "cs-dir": "cmo",
  // CFO's reports
  legal: "cfo",
  compliance: "cfo",
  "compliance-dir": "cfo",
  strategy: "cfo",
};

function getParentId(agent: AgentListItem): string | null {
  if (agent.id === "ceo") return null;
  if (C_SUITE_IDS.has(agent.id)) return "ceo";
  return DEPARTMENT_MAP[agent.id] || "ceo";
}

export function agentsToOrgChart(agents: AgentListItem[]): {
  nodes: Node[];
  edges: Edge[];
} {
  if (!agents || agents.length === 0) return { nodes: [], edges: [] };

  // Build parent-children map
  const childrenMap = new Map<string | null, AgentListItem[]>();
  const agentMap = new Map<string, AgentListItem>();

  for (const agent of agents) {
    agentMap.set(agent.id, agent);
    const parentId = getParentId(agent);
    if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
    childrenMap.get(parentId)!.push(agent);
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // BFS to assign positions level by level
  type QueueItem = { agentId: string; level: number };
  const queue: QueueItem[] = [];
  const levelAgents = new Map<number, string[]>();

  // Start with root nodes (those with no parent in the agent list, typically CEO)
  const roots = childrenMap.get(null) || [];
  for (const root of roots) {
    queue.push({ agentId: root.id, level: 0 });
  }

  // Also add agents whose parent doesn't exist in the list
  for (const agent of agents) {
    const parentId = getParentId(agent);
    if (parentId !== null && !agentMap.has(parentId) && !roots.includes(agent)) {
      queue.push({ agentId: agent.id, level: 0 });
    }
  }

  const visited = new Set<string>();

  while (queue.length > 0) {
    const { agentId, level } = queue.shift()!;
    if (visited.has(agentId)) continue;
    visited.add(agentId);

    if (!levelAgents.has(level)) levelAgents.set(level, []);
    levelAgents.get(level)!.push(agentId);

    const children = childrenMap.get(agentId) || [];
    for (const child of children) {
      if (!visited.has(child.id)) {
        queue.push({ agentId: child.id, level: level + 1 });
      }
    }
  }

  // Position nodes centered per level
  const maxLevelWidth = Math.max(...Array.from(levelAgents.values()).map((ids) => ids.length));
  const totalWidth = maxLevelWidth * (NODE_WIDTH + HORIZONTAL_GAP);

  for (const [level, agentIds] of levelAgents) {
    const levelWidth = agentIds.length * (NODE_WIDTH + HORIZONTAL_GAP) - HORIZONTAL_GAP;
    const startX = (totalWidth - levelWidth) / 2;

    for (let i = 0; i < agentIds.length; i++) {
      const agent = agentMap.get(agentIds[i]);
      if (!agent) continue;

      nodes.push({
        id: agent.id,
        type: "orgChartNode",
        position: {
          x: startX + i * (NODE_WIDTH + HORIZONTAL_GAP),
          y: level * (NODE_HEIGHT + VERTICAL_GAP),
        },
        data: {
          agentId: agent.id,
          name: agent.name,
          type: agent.type,
          status: agent.status,
        },
      });

      const parentId = getParentId(agent);
      if (parentId && agentMap.has(parentId)) {
        edges.push({
          id: `${parentId}-${agent.id}`,
          source: parentId,
          target: agent.id,
          type: "smoothstep",
        });
      }
    }
  }

  return { nodes, edges };
}
