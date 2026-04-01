import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

type GoalEdgeData = {
  edgeType?: string;
  color?: string;
  dashed?: boolean;
  dotted?: boolean;
  label?: string;
  inferred?: boolean;
};

export function GoalRefinementEdge(props: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });

  const edgeData = props.data as GoalEdgeData | undefined;
  const color = edgeData?.color || "var(--border-hover)";
  const dashed = edgeData?.dashed ?? false;
  const dotted = edgeData?.dotted ?? false;
  const inferred = edgeData?.inferred ?? false;

  let strokeDasharray: string | undefined;
  if (dotted) strokeDasharray = "3 3";
  else if (dashed) strokeDasharray = "6 4";

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: 2,
          strokeDasharray,
          opacity: inferred ? 0.5 : 1,
        }}
        markerEnd="url(#react-flow__arrowclosed)"
      />
      {inferred && edgeData?.label !== undefined && (
        <text x={labelX} y={labelY - 8} textAnchor="middle" fontSize={9} fill={color} opacity={0.7}>
          {edgeData.label || "AI"}
        </text>
      )}
    </>
  );
}
