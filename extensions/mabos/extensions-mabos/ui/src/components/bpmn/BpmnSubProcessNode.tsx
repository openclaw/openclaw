import { Position, NodeToolbar, type NodeProps } from "@xyflow/react";
import { clsx } from "clsx";
import { Minus, Plus } from "lucide-react";
import { useState } from "react";
import type { BpmnElement } from "@/lib/bpmn-types";
import { BpmnHandle } from "./BpmnHandle";

export function BpmnSubProcessNode({ data, selected }: NodeProps) {
  const { element, invalid } = data as { element: BpmnElement; invalid?: boolean };
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={clsx("bpmn-subprocess", selected && "bpmn-selected", invalid && "bpmn-invalid")}
      style={{ minWidth: expanded ? 400 : 200, minHeight: expanded ? 200 : 120 }}
    >
      <NodeToolbar
        position={Position.Top}
        align="center"
        className="flex gap-1 p-1 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] shadow-md"
      >
        <button className="nodrag px-2 py-1 text-xs rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]">
          Edit
        </button>
        <button className="nodrag px-2 py-1 text-xs rounded hover:bg-[var(--bg-tertiary)] text-[var(--accent-red)]">
          Delete
        </button>
      </NodeToolbar>

      <p className="text-xs font-medium text-[var(--text-primary)]">
        {element.name || "Sub-Process"}
      </p>

      {/* Expand/collapse marker */}
      <button className="bpmn-subprocess-marker nodrag" onClick={() => setExpanded(!expanded)}>
        {expanded ? <Minus className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
      </button>

      <BpmnHandle type="target" position={Position.Left} />
      <BpmnHandle type="source" position={Position.Right} />

      {invalid && <span className="bpmn-invalid-badge">!</span>}
    </div>
  );
}
