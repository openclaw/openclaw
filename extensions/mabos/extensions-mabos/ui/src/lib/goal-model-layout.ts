import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";
import { getPerspectiveById } from "./goal-perspectives";
import type { GoalPerspective, BusinessGoal, GoalLevel, GoalType, TroposGoalModel } from "./types";

// --- Node data types ---

export type GoalModelNodeData = {
  goalId: string;
  goalName: string;
  goalLevel: GoalLevel;
  goalType: GoalType;
  priority: number;
  description: string;
  desires: string[];
  actor?: string;
  category?: string;
  domain?: string;
  workflowCount: number;
};

export type GoalGroupLabelData = {
  label: string;
  count: number;
  color: string;
};

// --- Options ---

export type GoalModelLayoutOptions = {
  levelFilter?: GoalLevel | "all";
  typeFilter?: GoalType | "all";
  actorFilter?: string; // actor id or "all"
  groupBy?: GoalPerspective;
  goalModel?: TroposGoalModel; // needed for actor perspective groups
};

// --- Edge types ---

type GoalEdgeType = "refinement" | "delegation" | "contribution" | "hierarchy-inferred";

type GoalEdgeData = {
  edgeType: GoalEdgeType;
  color: string;
  dashed: boolean;
  dotted: boolean;
  label?: string;
  inferred?: boolean;
};

// --- Constants ---

const NODE_WIDTH = 280;
const NODE_HEIGHT = 160;
const GROUP_LABEL_HEIGHT = 40;
const GROUP_GAP = 60;

// --- Main function ---

export function goalsToGoalModelGraph(
  goalModel: TroposGoalModel,
  options: GoalModelLayoutOptions = {},
): { nodes: Node[]; edges: Edge[] } {
  const { levelFilter = "all", typeFilter = "all", actorFilter = "all", groupBy } = options;

  const allGoals = goalModel.goals ?? [];
  const dependencies = goalModel.dependencies ?? [];
  const refinements = goalModel.refinements ?? [];

  // 1. Filter goals
  const filtered = allGoals.filter((g) => {
    if (levelFilter !== "all" && g.level !== levelFilter) return false;
    if (typeFilter !== "all" && g.type !== typeFilter) return false;
    if (actorFilter !== "all" && g.actor !== actorFilter) return false;
    return true;
  });

  if (filtered.length === 0) return { nodes: [], edges: [] };

  // 2. Build edges with three-tier strategy
  const edges: Edge[] = [];
  const goalIds = new Set(filtered.map((g) => g.id));
  const connectedPairs = new Set<string>();

  const addEdgePair = (sourceId: string, targetId: string) => {
    connectedPairs.add(`${sourceId}->${targetId}`);
  };

  // Tier 1: Explicit refinements (parentGoalId on goal + refinements array)
  for (const goal of filtered) {
    if (goal.parentGoalId && goalIds.has(goal.parentGoalId)) {
      const edgeId = `e-parent-${goal.parentGoalId}-${goal.id}`;
      edges.push({
        id: edgeId,
        source: `goal-${goal.parentGoalId}`,
        target: `goal-${goal.id}`,
        type: "goalRefinementEdge",
        data: {
          edgeType: "refinement",
          color: "var(--accent-purple)",
          dashed: false,
          dotted: false,
        } satisfies GoalEdgeData,
      });
      addEdgePair(goal.parentGoalId, goal.id);
    }
  }

  for (const ref of refinements) {
    if (goalIds.has(ref.parentGoalId) && goalIds.has(ref.childGoalId)) {
      const pairKey = `${ref.parentGoalId}->${ref.childGoalId}`;
      if (connectedPairs.has(pairKey)) continue;

      edges.push({
        id: `e-ref-${ref.parentGoalId}-${ref.childGoalId}`,
        source: `goal-${ref.parentGoalId}`,
        target: `goal-${ref.childGoalId}`,
        type: "goalRefinementEdge",
        data: {
          edgeType: ref.inferred ? "hierarchy-inferred" : "refinement",
          color: ref.inferred ? "var(--accent-purple)" : "var(--accent-purple)",
          dashed: false,
          dotted: ref.inferred ?? false,
          label: ref.label,
          inferred: ref.inferred,
        } satisfies GoalEdgeData,
      });
      addEdgePair(ref.parentGoalId, ref.childGoalId);
    }
  }

  // Tier 2: Dependency-derived edges
  for (const dep of dependencies) {
    if (dep.goalId && goalIds.has(dep.goalId)) {
      // Find goals that belong to the "from" and "to" actors
      const fromGoals = filtered.filter((g) => g.actor === dep.from);
      const toGoals = filtered.filter((g) => g.actor === dep.to);
      const targetGoal = filtered.find((g) => g.id === dep.goalId);

      if (targetGoal) {
        // Connect the delegated/contributed goal to relevant goals in the other actor
        const sourceGoals = dep.from === targetGoal.actor ? toGoals : fromGoals;
        for (const sg of sourceGoals) {
          const pairKey = `${sg.id}->${targetGoal.id}`;
          if (connectedPairs.has(pairKey)) continue;

          edges.push({
            id: `e-dep-${sg.id}-${targetGoal.id}`,
            source: `goal-${sg.id}`,
            target: `goal-${targetGoal.id}`,
            type: "goalRefinementEdge",
            data: {
              edgeType: dep.type === "delegation" ? "delegation" : "contribution",
              color: dep.type === "delegation" ? "var(--accent-green)" : "var(--accent-blue)",
              dashed: dep.type === "contribution",
              dotted: false,
            } satisfies GoalEdgeData,
          });
          addEdgePair(sg.id, targetGoal.id);
        }
      }
    }
  }

  // Tier 3: Hierarchy-inferred (strategic → tactical → operational within same actor)
  const levelRank: Record<GoalLevel, number> = {
    strategic: 0,
    tactical: 1,
    operational: 2,
  };

  const goalsByActor = new Map<string, BusinessGoal[]>();
  for (const g of filtered) {
    const actor = g.actor || "__none__";
    const list = goalsByActor.get(actor) ?? [];
    list.push(g);
    goalsByActor.set(actor, list);
  }

  for (const [, actorGoals] of goalsByActor) {
    const sorted = [...actorGoals].sort((a, b) => levelRank[a.level] - levelRank[b.level]);

    for (let i = 0; i < sorted.length - 1; i++) {
      const parent = sorted[i];
      const child = sorted[i + 1];
      if (levelRank[parent.level] < levelRank[child.level]) {
        const pairKey = `${parent.id}->${child.id}`;
        if (connectedPairs.has(pairKey)) continue;

        edges.push({
          id: `e-hier-${parent.id}-${child.id}`,
          source: `goal-${parent.id}`,
          target: `goal-${child.id}`,
          type: "goalRefinementEdge",
          data: {
            edgeType: "hierarchy-inferred",
            color: "var(--text-muted)",
            dashed: false,
            dotted: true,
            inferred: true,
          } satisfies GoalEdgeData,
        });
        addEdgePair(parent.id, child.id);
      }
    }
  }

  // 3. Create Dagre graph and apply layout
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });

  for (const goal of filtered) {
    g.setNode(`goal-${goal.id}`, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  // 4. Build React Flow nodes
  const nodes: Node[] = [];

  for (const goal of filtered) {
    const nodeId = `goal-${goal.id}`;
    const dagreNode = g.node(nodeId);

    nodes.push({
      id: nodeId,
      type: "goalModelNode",
      position: {
        x: dagreNode.x - NODE_WIDTH / 2,
        y: dagreNode.y - NODE_HEIGHT / 2,
      },
      data: {
        goalId: goal.id,
        goalName: goal.text ?? goal.name ?? goal.id,
        goalLevel: goal.level,
        goalType: goal.type,
        priority: goal.priority,
        description: goal.description ?? "",
        desires: goal.desires ?? [],
        actor: goal.actor,
        category: goal.category,
        domain: goal.domain,
        workflowCount: goal.workflows?.length ?? 0,
      } satisfies GoalModelNodeData,
    });
  }

  // 5. Add group label nodes if groupBy is specified
  if (groupBy) {
    const perspective = getPerspectiveById(groupBy, options.goalModel);
    if (perspective) {
      for (const group of perspective.groups) {
        const groupGoals = filtered.filter(group.filterFn);
        if (groupGoals.length === 0) continue;

        // Find bounding box of group goals
        const groupNodeIds = groupGoals.map((gg) => `goal-${gg.id}`);
        const groupNodes = nodes.filter((n) => groupNodeIds.includes(n.id));

        if (groupNodes.length === 0) continue;

        const minX = Math.min(...groupNodes.map((n) => n.position.x));
        const maxX = Math.max(...groupNodes.map((n) => n.position.x + NODE_WIDTH));
        const minY = Math.min(...groupNodes.map((n) => n.position.y));

        nodes.push({
          id: `group-label-${group.id}`,
          type: "goalGroupLabel",
          position: {
            x: minX + (maxX - minX) / 2 - 100,
            y: minY - GROUP_LABEL_HEIGHT - GROUP_GAP,
          },
          data: {
            label: group.label,
            count: groupGoals.length,
            color: group.color,
          } satisfies GoalGroupLabelData,
          draggable: false,
          selectable: false,
        });
      }
    }
  }

  return { nodes, edges };
}
