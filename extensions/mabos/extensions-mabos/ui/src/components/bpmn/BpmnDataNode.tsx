import { Position, type NodeProps } from "@xyflow/react";
import { clsx } from "clsx";
import type { BpmnElement } from "@/lib/bpmn-types";
import { BpmnHandle } from "./BpmnHandle";

export function BpmnDataNode({ data, selected }: NodeProps) {
  const { element, invalid } = data as { element: BpmnElement; invalid?: boolean };

  return (
    <div className={clsx("bpmn-data", selected && "bpmn-selected", invalid && "bpmn-invalid")}>
      <p className="text-[9px] px-1 pt-4 text-center">{element.name || "Data"}</p>
      <BpmnHandle type="target" position={Position.Left} />
      <BpmnHandle type="source" position={Position.Right} />
    </div>
  );
}
