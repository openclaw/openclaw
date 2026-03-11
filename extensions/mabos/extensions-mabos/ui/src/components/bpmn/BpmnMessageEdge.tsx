import { BaseEdge, getSmoothStepPath, MarkerType, type EdgeProps } from "@xyflow/react";

export function BpmnMessageEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={MarkerType.Arrow}
      style={{
        stroke: "var(--bpmn-flow-message)",
        strokeWidth: selected ? 2.5 : 1.5,
        strokeDasharray: "8 4",
      }}
    />
  );
}
