import { BaseEdge, getStraightPath, type EdgeProps } from "@xyflow/react";

export function BpmnAssociationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
}: EdgeProps) {
  const [edgePath] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: "var(--bpmn-flow-association)",
        strokeWidth: selected ? 2 : 1,
        strokeDasharray: "3 3",
      }}
    />
  );
}
