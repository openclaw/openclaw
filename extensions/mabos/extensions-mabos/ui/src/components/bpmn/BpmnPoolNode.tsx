import { type NodeProps } from "@xyflow/react";
import { clsx } from "clsx";

export function BpmnPoolNode({ data, selected }: NodeProps) {
  const { name, invalid } = data as { name: string; invalid?: boolean };
  return (
    <div
      className={clsx("bpmn-pool flex", selected && "bpmn-selected", invalid && "bpmn-invalid")}
      style={{ width: "100%", minHeight: 200 }}
    >
      <div className="bpmn-pool-header">{name || "Pool"}</div>
      <div className="flex-1 relative" />
    </div>
  );
}
