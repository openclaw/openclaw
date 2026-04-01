import { Handle, Position } from "@xyflow/react";
import type { WorkflowGoalNodeData } from "@/lib/workflow-layout";

const levelColors: Record<string, string> = {
  strategic: "var(--accent-purple)",
  tactical: "var(--accent-blue)",
  operational: "var(--accent-orange)",
};

type WorkflowGoalNodeProps = {
  data: WorkflowGoalNodeData;
};

export function WorkflowGoalNode({ data }: WorkflowGoalNodeProps) {
  const color = levelColors[data.goalLevel] || "var(--accent-blue)";

  return (
    <div
      className="px-3 py-2.5 rounded-xl border-2 min-w-[180px] max-w-[200px]"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 8%, var(--bg-card))`,
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
      }}
    >
      <p className="text-xs font-medium text-[var(--text-primary)] line-clamp-2 leading-tight">
        {data.goalName}
      </p>
      <div className="flex items-center gap-1.5 mt-1.5">
        <span
          className="inline-block px-1.5 py-0.5 rounded text-[9px] font-medium capitalize"
          style={{
            backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
            color,
          }}
        >
          {data.goalLevel}
        </span>
      </div>
      <p className="text-[10px] text-[var(--text-muted)] mt-1 truncate">{data.workflowName}</p>
      <Handle type="source" position={Position.Right} className="!bg-[var(--border-hover)]" />
    </div>
  );
}
