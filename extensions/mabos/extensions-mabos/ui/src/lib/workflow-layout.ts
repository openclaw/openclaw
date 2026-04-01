import type { Node, Edge } from "@xyflow/react";
import type { TroposGoalModel } from "./types";

export type WorkflowGoalNodeData = {
  goalId: string;
  goalName: string;
  goalLevel: string;
  workflowName: string;
  workflowStatus: string;
  workflowId: string;
};

export type WorkflowStepNodeData = {
  stepId: string;
  stepName: string;
  order: number;
  workflowId: string;
  workflowStatus: string;
};

export type WorkflowFilter = {
  agent?: string; // "all" or agent id like "cmo"
  level?: string; // "all" or "strategic" | "tactical" | "operational"
};

const ROW_HEIGHT = 120;
const STEP_WIDTH = 200;
const GOAL_WIDTH = 220;

const levelColors: Record<string, string> = {
  strategic: "var(--accent-purple)",
  tactical: "var(--accent-blue)",
  operational: "var(--accent-orange)",
};

const statusColors: Record<string, string> = {
  active: "var(--accent-green)",
  completed: "var(--accent-blue)",
  paused: "var(--accent-orange)",
  pending: "var(--text-muted)",
};

export function workflowsToFlowGraph(
  goalModel: TroposGoalModel,
  filter?: WorkflowFilter,
): {
  nodes: Node[];
  edges: Edge[];
} {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let goals = goalModel.goals ?? [];

  if (filter?.agent && filter.agent !== "all") {
    const agentId = filter.agent;
    goals = goals.filter((g) => g.actor === agentId || g.actor?.endsWith(`-${agentId}`));
  }
  if (filter?.level && filter.level !== "all") {
    goals = goals.filter((g) => g.level === filter.level);
  }

  let rowIndex = 0;

  for (const goal of goals) {
    for (const workflow of goal.workflows ?? []) {
      const goalNodeId = `wf-goal-${goal.id}-${workflow.id}`;
      const goalLevel = goal.level || "tactical";
      const goalColor = levelColors[goalLevel] || "var(--accent-blue)";
      const wfStatus = workflow.status || "pending";
      const wfColor = statusColors[wfStatus] || "var(--text-muted)";

      // Goal entry node
      nodes.push({
        id: goalNodeId,
        type: "workflowGoalNode",
        position: { x: 0, y: rowIndex * ROW_HEIGHT },
        data: {
          goalId: goal.id,
          goalName: goal.text ?? goal.name ?? goal.id,
          goalLevel,
          workflowName: workflow.name,
          workflowStatus: wfStatus,
          workflowId: workflow.id,
        } satisfies WorkflowGoalNodeData,
      });

      // Sort steps by order
      const sortedSteps = [...(workflow.steps ?? [])].sort((a, b) => a.order - b.order);

      let prevNodeId = goalNodeId;

      for (let i = 0; i < sortedSteps.length; i++) {
        const step = sortedSteps[i];
        const stepNodeId = `wf-step-${workflow.id}-${step.id}`;

        nodes.push({
          id: stepNodeId,
          type: "workflowStepNode",
          position: {
            x: GOAL_WIDTH + i * STEP_WIDTH,
            y: rowIndex * ROW_HEIGHT,
          },
          data: {
            stepId: step.id,
            stepName: step.name,
            order: step.order,
            workflowId: workflow.id,
            workflowStatus: wfStatus,
          } satisfies WorkflowStepNodeData,
        });

        // Edge from previous node to this step
        const isFirstStep = i === 0;
        edges.push({
          id: `e-${prevNodeId}-${stepNodeId}`,
          source: prevNodeId,
          target: stepNodeId,
          type: "workflowEdge",
          animated: wfStatus === "active" && isFirstStep,
          data: {
            color: isFirstStep ? goalColor : wfColor,
            dashed: wfStatus === "pending",
          },
        });

        prevNodeId = stepNodeId;
      }

      rowIndex++;
    }
  }

  return { nodes, edges };
}
