import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

export function DependencyEdge(props: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });

  const depType = (props.data as any)?.type;
  const isDelegation = depType === "delegation";

  return (
    <BaseEdge
      path={edgePath}
      style={{
        stroke: isDelegation ? "var(--accent-green)" : "var(--accent-purple)",
        strokeWidth: isDelegation ? 2 : 1,
        strokeDasharray: isDelegation ? undefined : "5 5",
      }}
      markerEnd="url(#react-flow__arrowclosed)"
    />
  );
}
