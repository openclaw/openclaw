import type { Node, Edge } from "@xyflow/react";
import type { TroposGoalModel } from "./types";

export type ActorNodeData = {
  label: string;
  type: "principal" | "agent";
  goalCount: number;
};

export type GoalNodeData = {
  label: string;
  priority: number;
  level: string;
  type: string;
  actor: string;
};

export function troposToFlowGraph(goalModel: TroposGoalModel): {
  nodes: Node[];
  edges: Edge[];
} {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const actors = goalModel.actors ?? [];
  const goals = goalModel.goals ?? [];
  const dependencies = goalModel.dependencies ?? [];

  // Layout constants
  const ACTOR_SPACING = 220;
  const GOAL_Y_OFFSET = 200;
  const GOAL_SPACING = 180;

  // Create actor nodes
  const principalActors = actors.filter((a) => a.type === "principal");
  const agentActors = actors.filter((a) => a.type === "agent" || a.type !== "principal");

  // Place principal actors at top center
  principalActors.forEach((actor, idx) => {
    const totalWidth = principalActors.length * ACTOR_SPACING;
    const x = idx * ACTOR_SPACING - totalWidth / 2 + ACTOR_SPACING / 2 + 400;

    const actorGoals = goals.filter((g) => g.actor === actor.id);

    nodes.push({
      id: `actor-${actor.id}`,
      type: "actorNode",
      position: { x, y: 50 },
      data: {
        label: actor.id === "stakeholder" ? "Stakeholder" : actor.id.toUpperCase(),
        type: "principal",
        goalCount: actorGoals.length || actor.goals?.length || 0,
      },
    });
  });

  // Place agent actors in a row below
  agentActors.forEach((actor, idx) => {
    const totalWidth = agentActors.length * ACTOR_SPACING;
    const x = idx * ACTOR_SPACING - totalWidth / 2 + ACTOR_SPACING / 2 + 400;
    const y = 180;

    const actorGoals = goals.filter((g) => g.actor === actor.id);

    nodes.push({
      id: `actor-${actor.id}`,
      type: "actorNode",
      position: { x, y },
      data: {
        label: actor.id.toUpperCase(),
        type: "agent",
        goalCount: actorGoals.length || actor.goals?.length || 0,
      },
    });
  });

  // Create goal nodes grouped by actor
  const actorGoalPositions: Record<string, number> = {};
  goals.forEach((goal, idx) => {
    const actorId = goal.actor || "unknown";
    const actorIdx = actorGoalPositions[actorId] ?? 0;
    actorGoalPositions[actorId] = actorIdx + 1;

    // Find the actor node position for alignment
    const actorNode = nodes.find((n) => n.id === `actor-${actorId}`);
    const baseX = actorNode?.position.x ?? idx * GOAL_SPACING;
    const baseY = (actorNode?.position.y ?? 180) + GOAL_Y_OFFSET;

    nodes.push({
      id: `goal-${goal.id}`,
      type: "goalNode",
      position: {
        x: baseX + actorIdx * GOAL_SPACING - ((actorGoalPositions[actorId] - 1) * GOAL_SPACING) / 2,
        y: baseY + actorIdx * 80,
      },
      data: {
        label: goal.text ?? goal.name ?? goal.id,
        priority: goal.priority || 0.5,
        level: goal.level || "tactical",
        type: goal.type || "hard",
        actor: actorId,
      },
    });

    // Edge from actor to goal
    edges.push({
      id: `e-actor-${actorId}-goal-${goal.id}`,
      source: `actor-${actorId}`,
      target: `goal-${goal.id}`,
      type: "default",
      animated: false,
      style: { stroke: "var(--border-hover)", strokeWidth: 1 },
    });
  });

  // Create dependency edges
  dependencies.forEach((dep, idx) => {
    const isDelegation = dep.type === "delegation";
    edges.push({
      id: `e-dep-${idx}`,
      source: `actor-${dep.from}`,
      target: `actor-${dep.to}`,
      type: "dependencyEdge",
      animated: isDelegation,
      data: { type: dep.type },
      style: {
        stroke: isDelegation ? "var(--accent-green)" : "var(--accent-purple)",
        strokeWidth: isDelegation ? 2 : 1,
        strokeDasharray: isDelegation ? undefined : "5 5",
      },
    });
  });

  return { nodes, edges };
}
