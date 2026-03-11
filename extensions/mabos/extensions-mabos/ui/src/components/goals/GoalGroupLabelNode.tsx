import type { GoalGroupLabelData } from "@/lib/goal-model-layout";

type GoalGroupLabelNodeProps = {
  data: GoalGroupLabelData;
};

export function GoalGroupLabelNode({ data }: GoalGroupLabelNodeProps) {
  return (
    <div
      className="px-4 py-2 rounded-lg text-xs font-medium flex items-center gap-2"
      style={{
        backgroundColor: `color-mix(in srgb, ${data.color} 10%, var(--bg-secondary))`,
        color: data.color,
        border: `1px solid color-mix(in srgb, ${data.color} 25%, transparent)`,
      }}
    >
      <span>{data.label}</span>
      <span
        className="px-1.5 py-0.5 rounded-full text-[10px]"
        style={{
          backgroundColor: `color-mix(in srgb, ${data.color} 15%, transparent)`,
        }}
      >
        {data.count}
      </span>
    </div>
  );
}
