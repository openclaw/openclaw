import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  type Node,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import { Target } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { usePanels } from "@/contexts/PanelContext";
import { goalsToGoalModelGraph } from "@/lib/goal-model-layout";
import type {
  BusinessGoal,
  GoalLevel,
  GoalPerspective,
  GoalType,
  TroposGoalModel,
} from "@/lib/types";
import { GoalGroupLabelNode } from "./GoalGroupLabelNode";
import { GoalModelNode } from "./GoalModelNode";
import { GoalRefinementEdge } from "./GoalRefinementEdge";

const nodeTypes: NodeTypes = {
  goalModelNode: GoalModelNode,
  goalGroupLabel: GoalGroupLabelNode,
};

const edgeTypes: EdgeTypes = {
  goalRefinementEdge: GoalRefinementEdge,
};

type GoalModelDiagramProps = {
  goalModel: TroposGoalModel;
  goals: BusinessGoal[];
  isLoading: boolean;
  levelFilter: GoalLevel | "all";
  typeFilter: GoalType | "all";
  perspective: GoalPerspective;
};

export function GoalModelDiagram({
  goalModel,
  goals,
  isLoading,
  levelFilter,
  typeFilter,
  perspective,
}: GoalModelDiagramProps) {
  const { openDetailPanel } = usePanels();

  const { nodes, edges } = useMemo(() => {
    if (!goalModel || goals.length === 0) return { nodes: [], edges: [] };
    return goalsToGoalModelGraph(goalModel, {
      levelFilter,
      typeFilter,
      groupBy: perspective,
      goalModel,
    });
  }, [goalModel, goals, levelFilter, typeFilter, perspective]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type === "goalGroupLabel") return;
      const goalData = node.data as { goalId?: string };
      if (goalData.goalId) {
        const found = goals.find((g) => g.id === goalData.goalId);
        if (found) openDetailPanel("goal", found.id, found);
      }
    },
    [goals, openDetailPanel],
  );

  if (isLoading) {
    return (
      <div className="h-[600px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-mabos)] flex items-center justify-center">
        <div className="space-y-3 text-center">
          <Skeleton className="h-8 w-48 mx-auto" />
          <Skeleton className="h-4 w-32 mx-auto" />
        </div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="text-center py-12">
        <Target className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
        <p className="text-sm text-[var(--text-secondary)]">No goals match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ReactFlow canvas */}
      <div
        className="h-[600px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-mabos)] relative"
        style={{
          // @ts-expect-error CSS custom properties
          "--xy-background-color": "var(--bg-card)",
          "--xy-edge-stroke-default": "var(--border-hover)",
          "--xy-controls-button-background-color": "var(--bg-secondary)",
          "--xy-controls-button-border-color": "var(--border-mabos)",
          "--xy-controls-button-color": "var(--text-secondary)",
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          fitView
          minZoom={0.3}
          maxZoom={2}
          defaultEdgeOptions={{
            type: "smoothstep",
          }}
        >
          <Controls className="!bg-[var(--bg-secondary)] !border-[var(--border-mabos)] !shadow-none" />
          <Background
            variant={BackgroundVariant.Dots}
            color="var(--border-mabos)"
            gap={20}
            size={1}
          />
        </ReactFlow>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs text-[var(--text-muted)] flex-wrap">
        <span className="font-medium text-[var(--text-secondary)]">Edges:</span>
        <div className="flex items-center gap-1.5">
          <span className="w-6 h-0.5 bg-[var(--accent-purple)]" />
          Refinement
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-6 h-0.5 bg-[var(--accent-green)]" />
          Delegation
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="w-6 h-0.5"
            style={{
              backgroundImage:
                "repeating-linear-gradient(90deg, var(--accent-blue) 0, var(--accent-blue) 4px, transparent 4px, transparent 8px)",
            }}
          />
          Contribution
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="w-6 h-0.5"
            style={{
              backgroundImage:
                "repeating-linear-gradient(90deg, var(--text-muted) 0, var(--text-muted) 2px, transparent 2px, transparent 5px)",
              opacity: 0.5,
            }}
          />
          Inferred
        </div>
      </div>
    </div>
  );
}
