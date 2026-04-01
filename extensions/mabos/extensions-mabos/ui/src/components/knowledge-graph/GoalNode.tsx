import { Handle, Position } from "@xyflow/react";
import type { GoalNodeData } from "@/lib/graph-layout";

const levelColors: Record<string, string> = {
  strategic: "var(--accent-purple)",
  tactical: "var(--accent-blue)",
  operational: "var(--accent-orange)",
};

type GoalNodeProps = {
  data: GoalNodeData;
};

export function GoalNode({ data }: GoalNodeProps) {
  const color = levelColors[data.level] || "var(--accent-blue)";

  return (
    <div
      className="px-3 py-2 rounded-lg border max-w-[200px]"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 5%, var(--bg-card))`,
        borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      <Handle type="target" position={Position.Top} className="!bg-[var(--border-hover)]" />
      <p className="text-xs text-[var(--text-primary)] line-clamp-2 leading-tight">{data.label}</p>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[9px] capitalize" style={{ color }}>
          {data.level}
        </span>
        <div className="flex items-center gap-1">
          <div className="w-8 h-1 rounded-full bg-[var(--bg-tertiary)]">
            <div
              className="h-full rounded-full"
              style={{ width: `${data.priority * 100}%`, backgroundColor: color }}
            />
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-[var(--border-hover)]" />
    </div>
  );
}
