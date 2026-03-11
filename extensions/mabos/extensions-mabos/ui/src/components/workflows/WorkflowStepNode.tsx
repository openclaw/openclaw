import { Handle, Position } from "@xyflow/react";
import type { WorkflowStepNodeData } from "@/lib/workflow-layout";

const statusColors: Record<string, string> = {
  active: "var(--accent-green)",
  completed: "var(--accent-blue)",
  paused: "var(--accent-orange)",
  pending: "var(--text-muted)",
};

type WorkflowStepNodeProps = {
  data: WorkflowStepNodeData;
};

export function WorkflowStepNode({ data }: WorkflowStepNodeProps) {
  const color = statusColors[data.workflowStatus] || "var(--text-muted)";

  return (
    <div
      className="px-3 py-2 rounded-lg border min-w-[150px] max-w-[180px]"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 5%, var(--bg-card))`,
        borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-[var(--border-hover)]" />
      <div className="flex items-center gap-2">
        <span
          className="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0"
          style={{
            backgroundColor: `color-mix(in srgb, ${color} 20%, transparent)`,
            color,
          }}
        >
          {data.order}
        </span>
        <p className="text-xs text-[var(--text-primary)] line-clamp-2 leading-tight">
          {data.stepName}
        </p>
      </div>
      <div className="flex items-center gap-1 mt-1.5">
        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-[9px] capitalize" style={{ color }}>
          {data.workflowStatus}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-[var(--border-hover)]" />
    </div>
  );
}
