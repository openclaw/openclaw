import { useParams, Link } from "@tanstack/react-router";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { ArrowLeft, Save, CheckCircle2, Undo2, Redo2, Loader2, AlertCircle } from "lucide-react";
import { useCallback, useRef, type DragEvent } from "react";
import {
  BpmnEventNode,
  BpmnTaskNode,
  BpmnGatewayNode,
  BpmnSubProcessNode,
  BpmnPoolNode,
  BpmnLaneNode,
  BpmnDataNode,
  BpmnAnnotationNode,
  BpmnSequenceEdge,
  BpmnMessageEdge,
  BpmnAssociationEdge,
} from "@/components/bpmn";
import { BpmnPalette } from "@/components/bpmn/BpmnPalette";
import { useWorkflowEditor } from "@/hooks/useWorkflowEditor";

// Define node/edge types outside component to prevent re-renders
const nodeTypes: NodeTypes = {
  bpmnEvent: BpmnEventNode,
  bpmnTask: BpmnTaskNode,
  bpmnGateway: BpmnGatewayNode,
  bpmnSubProcess: BpmnSubProcessNode,
  bpmnPool: BpmnPoolNode,
  bpmnLane: BpmnLaneNode,
  bpmnData: BpmnDataNode,
  bpmnAnnotation: BpmnAnnotationNode,
};

const edgeTypes: EdgeTypes = {
  bpmnSequence: BpmnSequenceEdge,
  bpmnMessage: BpmnMessageEdge,
  bpmnAssociation: BpmnAssociationEdge,
};

// SVG marker definitions for BPMN flows
function BpmnMarkerDefs() {
  return (
    <svg style={{ position: "absolute", top: 0, left: 0, width: 0, height: 0 }}>
      <defs>
        <marker
          id="bpmn-message-circle"
          viewBox="0 0 20 20"
          markerWidth={10}
          markerHeight={10}
          refX={10}
          refY={10}
        >
          <circle
            cx={10}
            cy={10}
            r={6}
            fill="none"
            stroke="var(--bpmn-flow-message)"
            strokeWidth={2}
          />
        </marker>
        <marker
          id="bpmn-default-slash"
          viewBox="0 0 20 20"
          markerWidth={10}
          markerHeight={10}
          refX={10}
          refY={10}
        >
          <line
            x1={10}
            y1={3}
            x2={10}
            y2={17}
            stroke="var(--bpmn-flow-default-marker)"
            strokeWidth={2}
          />
        </marker>
      </defs>
    </svg>
  );
}

const statusColors: Record<string, string> = {
  active: "var(--accent-green)",
  completed: "var(--accent-blue)",
  paused: "var(--accent-orange)",
  pending: "var(--text-muted)",
};

export function WorkflowEditorPage() {
  const { workflowId } = useParams({ strict: false }) as { workflowId: string };
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    deleteSelected,
    undo,
    redo,
    isDirty,
    save,
    validate,
    validationErrors,
    workflow,
    isLoading,
    error,
  } = useWorkflowEditor(workflowId);

  // Handle palette drop onto canvas
  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData("application/bpmn-element");
      if (!raw) return;

      const { type, subType } = JSON.parse(raw);

      // Get position relative to the React Flow canvas
      const bounds = reactFlowWrapper.current?.getBoundingClientRect();
      if (!bounds) return;

      const position = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };

      addNode(type, subType, position);
    },
    [addNode],
  );

  // Keyboard shortcuts
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelected();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "z") {
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        event.preventDefault();
      }
    },
    [deleteSelected, undo, redo],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <AlertCircle className="w-8 h-8 text-[var(--accent-red)]" />
        <p className="text-sm text-[var(--text-secondary)]">Failed to load workflow</p>
        <Link to="/workflows" className="text-xs text-[var(--accent-blue)] hover:underline">
          Back to Workflows
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" onKeyDown={onKeyDown} tabIndex={0}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border-mabos)] bg-[var(--bg-secondary)]">
        <Link
          to="/workflows"
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <h1 className="text-sm font-semibold text-[var(--text-primary)] flex-1 truncate">
          {workflow?.name || "Workflow Editor"}
        </h1>
        {workflow?.status && (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-medium"
            style={{
              color: statusColors[workflow.status] || "var(--text-muted)",
              backgroundColor: `color-mix(in srgb, ${statusColors[workflow.status] || "var(--text-muted)"} 12%, transparent)`,
            }}
          >
            {workflow.status}
          </span>
        )}
        {isDirty && <span className="text-[10px] text-[var(--accent-orange)]">Unsaved</span>}
        <div className="flex items-center gap-1">
          <button
            onClick={undo}
            className="p-1.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)]"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={redo}
            className="p-1.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)]"
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <button
          onClick={validate}
          className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md
            border border-[var(--border-mabos)] hover:bg-[var(--bg-hover)]
            text-[var(--text-secondary)]"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          Validate
          {validationErrors.length > 0 && (
            <span className="ml-1 px-1 py-0.5 text-[9px] rounded-full bg-[var(--accent-red)] text-white">
              {validationErrors.length}
            </span>
          )}
        </button>
        <button
          onClick={save}
          className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md
            bg-[var(--accent-blue)] text-white hover:opacity-90"
        >
          <Save className="w-3.5 h-3.5" />
          Save
        </button>
      </div>

      {/* Main editor area */}
      <div className="flex flex-1 overflow-hidden">
        <BpmnPalette />
        <div ref={reactFlowWrapper} className="flex-1">
          <BpmnMarkerDefs />
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDragOver={onDragOver}
            onDrop={onDrop}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            snapToGrid
            snapGrid={[10, 10]}
            className="bg-[var(--bg-primary)]"
            defaultEdgeOptions={{
              type: "bpmnSequence",
            }}
          >
            <Controls
              className="!bg-[var(--bg-secondary)] !border-[var(--border-mabos)] !shadow-md
                [&>button]:!bg-[var(--bg-secondary)] [&>button]:!border-[var(--border-mabos)]
                [&>button]:!text-[var(--text-secondary)] [&>button:hover]:!bg-[var(--bg-hover)]"
            />
            <MiniMap
              className="!bg-[var(--bg-secondary)] !border-[var(--border-mabos)]"
              maskColor="color-mix(in srgb, var(--bg-primary) 70%, transparent)"
              nodeColor="var(--border-mabos)"
            />
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="var(--border-mabos)"
            />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
