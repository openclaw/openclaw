import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  type Node,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import { Network, AlertCircle } from "lucide-react";
import { useMemo, useCallback } from "react";
import "@xyflow/react/dist/style.css";
import { ActorNode } from "@/components/knowledge-graph/ActorNode";
import { DependencyEdge } from "@/components/knowledge-graph/DependencyEdge";
import { GoalNode } from "@/components/knowledge-graph/GoalNode";
import { Skeleton } from "@/components/ui/skeleton";
import { usePanels } from "@/contexts/PanelContext";
import { useGoalModel } from "@/hooks/useGoalModel";
import { troposToFlowGraph } from "@/lib/graph-layout";

const BUSINESS_ID = "vividwalls";

const nodeTypes: NodeTypes = {
  actorNode: ActorNode,
  goalNode: GoalNode,
};

const edgeTypes: EdgeTypes = {
  dependencyEdge: DependencyEdge,
};

export function KnowledgeGraphPage() {
  const { data: goalModel, isLoading, error } = useGoalModel(BUSINESS_ID);
  const { openDetailPanel } = usePanels();

  const { nodes, edges } = useMemo(() => {
    if (!goalModel) return { nodes: [], edges: [] };
    return troposToFlowGraph(goalModel);
  }, [goalModel]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      openDetailPanel("knowledge-graph-node", node.id, node);
    },
    [openDetailPanel],
  );

  const onPaneClick = useCallback(() => {
    // Clicking pane doesn't need to do anything special now;
    // the detail panel auto-closes on route change
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-lg"
          style={{
            backgroundColor: `color-mix(in srgb, var(--accent-blue) 15%, transparent)`,
          }}
        >
          <Network className="w-5 h-5 text-[var(--accent-blue)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Knowledge Graph</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {isLoading
              ? "Loading graph..."
              : `Tropos goal model - ${nodes.length} nodes, ${edges.length} edges`}
          </p>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[color-mix(in_srgb,var(--accent-red)_10%,var(--bg-card))] border border-[var(--accent-red)]/20">
          <AlertCircle className="w-5 h-5 text-[var(--accent-red)] shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Failed to load goal model
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Unable to fetch Tropos model from the API.
            </p>
          </div>
        </div>
      )}

      {/* Graph Canvas */}
      {isLoading ? (
        <div className="h-[600px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-mabos)] flex items-center justify-center">
          <div className="space-y-3 text-center">
            <Skeleton className="h-8 w-48 mx-auto" />
            <Skeleton className="h-4 w-32 mx-auto" />
          </div>
        </div>
      ) : (
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
            onPaneClick={onPaneClick}
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
      )}

      {/* Legend */}
      {!isLoading && nodes.length > 0 && (
        <div className="flex items-center gap-6 text-xs text-[var(--text-muted)]">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded border-2 border-[var(--accent-green)]/40 bg-[color-mix(in_srgb,var(--accent-green)_8%,transparent)]" />
            Principal (Stakeholder)
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded border-2 border-[var(--accent-purple)]/40 bg-[color-mix(in_srgb,var(--accent-purple)_8%,transparent)]" />
            Agent
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-6 h-0.5 bg-[var(--accent-green)]" />
            Delegation
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="w-6 h-0.5 bg-[var(--accent-purple)]"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(90deg, var(--accent-purple) 0, var(--accent-purple) 4px, transparent 4px, transparent 8px)",
              }}
            />
            Contribution
          </div>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && nodes.length === 0 && (
        <div className="text-center py-12">
          <Network className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <p className="text-sm text-[var(--text-secondary)]">
            No graph data available. Set up business goals to populate the knowledge graph.
          </p>
        </div>
      )}
    </div>
  );
}
