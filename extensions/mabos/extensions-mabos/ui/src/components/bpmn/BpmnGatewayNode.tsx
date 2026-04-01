import { Position, NodeToolbar, type NodeProps } from "@xyflow/react";
import { clsx } from "clsx";
import type { GatewayType } from "@/lib/bpmn-types";
import type { BpmnElement } from "@/lib/bpmn-types";
import { BpmnHandle } from "./BpmnHandle";

function GatewaySymbol({ type }: { type?: GatewayType }) {
  switch (type) {
    case "exclusive":
      return <span>X</span>;
    case "parallel":
      return <span>+</span>;
    case "inclusive":
      return <span>O</span>;
    case "eventBased":
      return <span>&#x25CB;</span>; // circle
    case "complex":
      return <span>*</span>;
    default:
      return <span>X</span>;
  }
}

export function BpmnGatewayNode({ data, selected }: NodeProps) {
  const { element, invalid } = data as { element: BpmnElement; invalid?: boolean };

  return (
    <div className={clsx("bpmn-gateway", selected && "bpmn-selected", invalid && "bpmn-invalid")}>
      <NodeToolbar
        position={Position.Top}
        align="center"
        className="flex gap-1 p-1 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] shadow-md"
        style={{ transform: "rotate(-45deg)" }}
      >
        <button className="nodrag px-2 py-1 text-xs rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]">
          Edit
        </button>
        <button className="nodrag px-2 py-1 text-xs rounded hover:bg-[var(--bg-tertiary)] text-[var(--accent-red)]">
          Delete
        </button>
      </NodeToolbar>

      <div className="bpmn-gateway-inner">
        <GatewaySymbol type={element.gatewayType} />
      </div>

      {/* Handles — counter-rotate so they point left/right in viewport */}
      <BpmnHandle type="target" position={Position.Left} style={{ transform: "rotate(-45deg)" }} />
      <BpmnHandle type="source" position={Position.Right} style={{ transform: "rotate(-45deg)" }} />

      {invalid && (
        <span className="bpmn-invalid-badge" style={{ transform: "rotate(-45deg)" }}>
          !
        </span>
      )}
    </div>
  );
}
