import { BaseEdge, getSmoothStepPath, MarkerType, type EdgeProps } from "@xyflow/react";

export function BpmnSequenceEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
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

  const edgeData = data as
    | {
        color?: string;
        dashed?: boolean;
        animated?: boolean;
        label?: string;
      }
    | undefined;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={MarkerType.ArrowClosed}
        style={{
          stroke: edgeData?.color || "var(--bpmn-flow-sequence)",
          strokeWidth: selected ? 2.5 : 1.5,
          strokeDasharray: edgeData?.dashed ? "6 4" : undefined,
        }}
      />
      {/* Animated dot for active flows */}
      {edgeData?.animated && (
        <circle r="4" fill="var(--bpmn-status-active)">
          <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
      {edgeData?.label && (
        <text>
          <textPath
            href={`#${id}`}
            startOffset="50%"
            textAnchor="middle"
            className="text-[10px] fill-[var(--text-muted)]"
          >
            {edgeData.label}
          </textPath>
        </text>
      )}
    </>
  );
}
