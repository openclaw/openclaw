import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

export function WorkflowEdge(props: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });

  const edgeData = props.data as { color?: string; dashed?: boolean } | undefined;
  const color = edgeData?.color || "var(--border-hover)";
  const dashed = edgeData?.dashed ?? false;

  return (
    <BaseEdge
      path={edgePath}
      style={{
        stroke: color,
        strokeWidth: 2,
        strokeDasharray: dashed ? "6 4" : undefined,
      }}
      markerEnd="url(#react-flow__arrowclosed)"
    />
  );
}
