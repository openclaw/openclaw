import { type NodeProps } from "@xyflow/react";
import { clsx } from "clsx";

export function BpmnLaneNode({ data, selected }: NodeProps) {
  const { name, invalid } = data as { name: string; invalid?: boolean };
  return (
    <div
      className={clsx("bpmn-lane", selected && "bpmn-selected", invalid && "bpmn-invalid")}
      style={{ width: "100%", minHeight: 120 }}
    >
      <div className="bpmn-lane-label">{name || "Lane"}</div>
    </div>
  );
}
