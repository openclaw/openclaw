import { ReactFlow, Controls, Background, BackgroundVariant, type NodeTypes } from "@xyflow/react";
import { Users } from "lucide-react";
import { useMemo, useCallback } from "react";
import "@xyflow/react/dist/style.css";
import { Skeleton } from "@/components/ui/skeleton";
import { agentsToOrgChart } from "@/lib/org-chart-layout";
import type { AgentListItem } from "@/lib/types";
import { OrgChartNode } from "./OrgChartNode";

const nodeTypes: NodeTypes = {
  orgChartNode: OrgChartNode,
};

type AgentOrgChartProps = {
  agents: AgentListItem[] | undefined;
  isLoading: boolean;
  onSelectAgent: (id: string) => void;
};

export function AgentOrgChart({ agents, isLoading, onSelectAgent }: AgentOrgChartProps) {
  const { nodes, edges } = useMemo(() => {
    if (!agents) return { nodes: [], edges: [] };
    return agentsToOrgChart(agents);
  }, [agents]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: { id: string }) => {
      onSelectAgent(node.id);
    },
    [onSelectAgent],
  );

  if (isLoading) {
    return (
      <div className="h-[500px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-mabos)] flex items-center justify-center">
        <div className="space-y-3 text-center">
          <Skeleton className="h-8 w-48 mx-auto" />
          <Skeleton className="h-4 w-32 mx-auto" />
        </div>
      </div>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <div className="text-center py-12">
        <Users className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
        <p className="text-sm font-medium text-[var(--text-secondary)] mb-1">No agents yet</p>
        <p className="text-xs text-[var(--text-muted)]">
          Create your first agent to see the org chart
        </p>
      </div>
    );
  }

  return (
    <div
      className="h-[500px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-mabos)] relative"
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
        onNodeClick={onNodeClick}
        fitView
        minZoom={0.3}
        maxZoom={2}
        defaultEdgeOptions={{ type: "smoothstep" }}
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
  );
}
