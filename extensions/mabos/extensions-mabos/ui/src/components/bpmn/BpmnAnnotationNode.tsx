import { Position, type NodeProps } from "@xyflow/react";
import type { BpmnElement } from "@/lib/bpmn-types";
import { BpmnHandle } from "./BpmnHandle";

export function BpmnAnnotationNode({ data }: NodeProps) {
  const { element } = data as { element: BpmnElement };

  return (
    <div className="bpmn-annotation">
      <p>{element.name || element.documentation || "Annotation"}</p>
      <BpmnHandle type="target" position={Position.Left} />
    </div>
  );
}
