import { Position, NodeToolbar, type NodeProps } from "@xyflow/react";
import { clsx } from "clsx";
import {
  User,
  Cog,
  Code,
  BookOpen,
  Send,
  Inbox,
  Hand,
  RotateCcw,
  Columns2,
  Rows2,
} from "lucide-react";
import type { BpmnElement, TaskType, LoopType } from "@/lib/bpmn-types";
import { BpmnHandle } from "./BpmnHandle";

function TaskTypeIcon({ type, className }: { type?: TaskType; className?: string }) {
  const c = className || "w-4 h-4";
  switch (type) {
    case "user":
      return <User className={c} />;
    case "service":
      return <Cog className={c} />;
    case "script":
      return <Code className={c} />;
    case "businessRule":
      return <BookOpen className={c} />;
    case "send":
      return <Send className={c} />;
    case "receive":
      return <Inbox className={c} />;
    case "manual":
      return <Hand className={c} />;
    default:
      return null;
  }
}

function LoopMarker({ type }: { type?: LoopType }) {
  if (!type || type === "none") return null;
  const c = "w-3 h-3 text-[var(--text-muted)]";
  switch (type) {
    case "standard":
      return <RotateCcw className={c} />;
    case "multiInstanceParallel":
      return <Columns2 className={c} />;
    case "multiInstanceSequential":
      return <Rows2 className={c} />;
    default:
      return null;
  }
}

export function BpmnTaskNode({ data, selected }: NodeProps) {
  const { element, invalid } = data as { element: BpmnElement; invalid?: boolean };

  return (
    <div
      className={clsx("bpmn-task relative", selected && "bpmn-selected", invalid && "bpmn-invalid")}
      data-selected={selected}
    >
      {/* Drag handle — full surface */}
      <div className="bpmn-drag-handle absolute inset-0 cursor-grab" />

      <NodeToolbar
        position={Position.Top}
        align="center"
        className="flex gap-1 p-1 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] shadow-md"
      >
        <button className="nodrag px-2 py-1 text-xs rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]">
          Edit
        </button>
        <button className="nodrag px-2 py-1 text-xs rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]">
          Duplicate
        </button>
        <button className="nodrag px-2 py-1 text-xs rounded hover:bg-[var(--bg-tertiary)] text-[var(--accent-red)]">
          Delete
        </button>
      </NodeToolbar>

      {/* Task type icon */}
      <TaskTypeIcon type={element.taskType} className="bpmn-task-icon" />

      {/* Content */}
      <p className="relative z-10 text-xs font-medium mt-4 pointer-events-none text-[var(--text-primary)]">
        {element.name || "Task"}
      </p>
      {element.assignee && (
        <p className="relative z-10 text-[10px] mt-0.5 pointer-events-none text-[var(--text-muted)]">
          {element.assignee}
        </p>
      )}

      {/* Loop/multi-instance markers */}
      {element.loopType && element.loopType !== "none" && (
        <div className="bpmn-task-marker">
          <LoopMarker type={element.loopType} />
        </div>
      )}

      {/* Connection handles */}
      <BpmnHandle type="target" position={Position.Left} />
      <BpmnHandle type="source" position={Position.Right} maxConnections={1} />

      {/* Validation badge */}
      {invalid && <span className="bpmn-invalid-badge">!</span>}
    </div>
  );
}
