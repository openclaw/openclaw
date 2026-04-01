import { Position, NodeToolbar, type NodeProps } from "@xyflow/react";
import { clsx } from "clsx";
import { Play, Square, Timer, Mail, Zap, AlertTriangle } from "lucide-react";
import type { BpmnElement, EventTrigger } from "@/lib/bpmn-types";
import { BpmnHandle } from "./BpmnHandle";

function TriggerIcon({ trigger, className }: { trigger?: EventTrigger; className?: string }) {
  const c = className || "w-4 h-4";
  switch (trigger) {
    case "timer":
      return <Timer className={c} />;
    case "message":
      return <Mail className={c} />;
    case "signal":
      return <Zap className={c} />;
    case "error":
      return <AlertTriangle className={c} />;
    case "terminate":
      return <Square className={c} />;
    case "none":
    default:
      return null;
  }
}

export function BpmnEventNode({ data, selected }: NodeProps) {
  const { element, invalid } = data as { element: BpmnElement; invalid?: boolean };
  const pos = element.eventPosition || "start";

  const positionClass: Record<string, string> = {
    start: "bpmn-event-start",
    intermediate: "bpmn-event-intermediate",
    end: "bpmn-event-end",
  };

  return (
    <div
      className={clsx(positionClass[pos], selected && "bpmn-selected", invalid && "bpmn-invalid")}
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

      {pos === "start" && !element.eventTrigger ? (
        <Play className="w-3.5 h-3.5" style={{ color: "var(--bpmn-event-start-border)" }} />
      ) : (
        <TriggerIcon trigger={element.eventTrigger} className="w-3.5 h-3.5" />
      )}

      {/* Handles — start event: source only; end event: target only */}
      {pos !== "start" && <BpmnHandle type="target" position={Position.Left} />}
      {pos !== "end" && (
        <BpmnHandle
          type="source"
          position={Position.Right}
          maxConnections={pos === "start" ? 1 : Infinity}
        />
      )}

      {invalid && <span className="bpmn-invalid-badge">!</span>}
    </div>
  );
}
