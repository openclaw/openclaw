import { Handle, Position } from "@xyflow/react";
import { GitBranch } from "lucide-react";
import type { GoalModelNodeData } from "@/lib/goal-model-layout";
import type { GoalLevel } from "@/lib/types";

const levelColors: Record<GoalLevel, string> = {
  strategic: "var(--accent-purple)",
  tactical: "var(--accent-blue)",
  operational: "var(--accent-orange)",
};

type GoalModelNodeProps = {
  data: GoalModelNodeData;
};

export function GoalModelNode({ data }: GoalModelNodeProps) {
  const color = levelColors[data.goalLevel] || "var(--accent-blue)";

  return (
    <div
      className="rounded-xl border bg-[var(--bg-card)] min-w-[240px] max-w-[280px] cursor-pointer hover:border-[var(--border-hover)] transition-colors"
      style={{
        borderLeftWidth: 3,
        borderLeftColor: color,
        borderColor: `color-mix(in srgb, ${color} 25%, var(--border-mabos))`,
      }}
    >
      <Handle type="target" position={Position.Top} className="!bg-[var(--border-hover)]" />

      <div className="px-3 py-2.5 space-y-2">
        {/* Goal name */}
        <p className="text-xs font-medium text-[var(--text-primary)] line-clamp-2 leading-tight">
          {data.goalName}
        </p>

        {/* Badges */}
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block px-1.5 py-0.5 rounded text-[9px] font-medium capitalize"
            style={{
              backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
              color,
            }}
          >
            {data.goalLevel}
          </span>
          <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-medium capitalize text-[var(--text-muted)] bg-[var(--bg-tertiary)]">
            {data.goalType}
          </span>
        </div>

        {/* Priority bar */}
        <div className="flex items-center gap-1.5">
          <div className="flex-1 h-1 rounded-full bg-[var(--bg-tertiary)]">
            <div
              className="h-full rounded-full"
              style={{
                width: `${data.priority * 100}%`,
                backgroundColor: color,
              }}
            />
          </div>
          <span className="text-[9px] text-[var(--text-muted)]">
            {(data.priority * 100).toFixed(0)}%
          </span>
        </div>

        {/* Description */}
        {data.description && (
          <p className="text-[10px] text-[var(--text-secondary)] line-clamp-1">
            {data.description}
          </p>
        )}

        {/* Workflow count */}
        {data.workflowCount > 0 && (
          <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
            <GitBranch className="w-3 h-3" />
            {data.workflowCount} workflow{data.workflowCount !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-[var(--border-hover)]" />
    </div>
  );
}
