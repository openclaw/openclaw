import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";

type OrgChartNodeData = {
  agentId: string;
  name: string;
  type: "core" | "domain";
  status: "active" | "idle" | "error" | "paused";
};

const statusColors: Record<string, string> = {
  active: "bg-[var(--accent-green)]",
  idle: "bg-[var(--accent-orange)]",
  error: "bg-[var(--accent-red)]",
  paused: "bg-[var(--text-muted)]",
};

export function OrgChartNode({ data }: NodeProps) {
  const nodeData = data as unknown as OrgChartNodeData;
  const Icon = getAgentIcon(nodeData.agentId);
  const displayName = getAgentName(nodeData.agentId);

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-[var(--border-mabos)]" />
      <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-mabos)] shadow-sm min-w-[170px] hover:border-[var(--border-hover)] transition-colors cursor-pointer">
        <div
          className="flex items-center justify-center w-8 h-8 rounded-md shrink-0"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent-purple) 15%, transparent)",
          }}
        >
          <Icon className="w-4 h-4 text-[var(--accent-purple)]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-[var(--text-primary)] truncate">{displayName}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div
              className={`w-1.5 h-1.5 rounded-full ${statusColors[nodeData.status] || statusColors.idle}`}
            />
            <span className="text-[10px] text-[var(--text-muted)] capitalize">
              {nodeData.status}
            </span>
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-[var(--border-mabos)]" />
    </>
  );
}
