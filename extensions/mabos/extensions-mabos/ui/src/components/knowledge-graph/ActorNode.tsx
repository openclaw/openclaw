import { Handle, Position } from "@xyflow/react";
import { User, Crown } from "lucide-react";
import type { ActorNodeData } from "@/lib/graph-layout";

type ActorNodeProps = {
  data: ActorNodeData;
};

export function ActorNode({ data }: ActorNodeProps) {
  const isPrincipal = data.type === "principal";
  const color = isPrincipal ? "var(--accent-green)" : "var(--accent-purple)";
  const Icon = isPrincipal ? Crown : User;

  return (
    <div
      className="px-4 py-3 rounded-xl border-2 min-w-[140px] text-center"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 8%, var(--bg-card))`,
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
      }}
    >
      <Handle type="target" position={Position.Top} className="!bg-[var(--border-hover)]" />
      <div className="flex items-center justify-center gap-2">
        <Icon className="w-4 h-4" style={{ color }} />
        <span className="text-sm font-medium text-[var(--text-primary)]">{data.label}</span>
      </div>
      {data.goalCount > 0 && (
        <span
          className="inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
          style={{
            backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
            color,
          }}
        >
          {data.goalCount} goal{data.goalCount !== 1 ? "s" : ""}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-[var(--border-hover)]" />
    </div>
  );
}
