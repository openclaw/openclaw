import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type OnConnect,
  type OnNodesChange,
} from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { BpmnCommandStack } from "@/lib/bpmn-command-stack";
import {
  elementTypeToNodeType,
  flowTypeToEdgeType,
  type BpmnElement,
  type BpmnFlow,
  type BpmnValidationError,
} from "@/lib/bpmn-types";

// Convert BpmnElement → React Flow Node
function elementToNode(el: BpmnElement): Node {
  return {
    id: el.id,
    type: elementTypeToNodeType(el.type),
    position: el.position,
    dragHandle: ".bpmn-drag-handle",
    data: { element: el, invalid: false },
  };
}

// Convert BpmnFlow → React Flow Edge
function flowToEdge(flow: BpmnFlow): Edge {
  return {
    id: flow.id,
    source: flow.sourceId,
    target: flow.targetId,
    type: flowTypeToEdgeType(flow.type),
    data: {
      label: flow.name,
      dashed: flow.type === "message",
    },
  };
}

export function useWorkflowEditor(workflowId: string) {
  const queryClient = useQueryClient();
  const commandStack = useRef(new BpmnCommandStack()).current;
  const positionDebounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [isDirty, setIsDirty] = useState(false);
  const [validationErrors, setValidationErrors] = useState<BpmnValidationError[]>([]);

  // Fetch workflow data
  const {
    data: workflow,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["bpmn-workflow", workflowId],
    queryFn: () => api.getWorkflow(workflowId),
    enabled: !!workflowId,
  });

  // React Flow state
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);

  // Initialize nodes/edges from workflow data
  useEffect(() => {
    if (!workflow) return;
    const rfNodes = (workflow.elements || []).map(elementToNode);
    const rfEdges = (workflow.flows || []).map(flowToEdge);
    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [workflow, setNodes, setEdges]);

  // Handle node position changes (debounced save)
  const handleNodesChange: OnNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes);
      // Check for position changes to debounce-save
      let hasPositionChanges = false;
      for (const c of changes) {
        if (c.type === "position" && c.position) {
          hasPositionChanges = true;
          break;
        }
      }
      if (hasPositionChanges) {
        setIsDirty(true);
        clearTimeout(positionDebounce.current);
        positionDebounce.current = setTimeout(() => {
          for (const change of changes) {
            if (change.type === "position" && change.position) {
              api.updateElementPosition(workflowId, change.id, change.position).catch(() => {});
            }
          }
        }, 500);
      }
    },
    [onNodesChange, workflowId],
  );

  // Handle new connections
  const onConnect: OnConnect = useCallback(
    (params) => {
      if (!params.source || !params.target) return;
      const flowId = `bpmn-fl-${crypto.randomUUID()}`;
      const newEdge: Edge = {
        id: flowId,
        source: params.source,
        target: params.target,
        type: "bpmnSequence",
      };

      setEdges((eds) => addEdge(newEdge, eds));
      setIsDirty(true);

      // Persist to backend
      api
        .addFlow(workflowId, {
          sourceId: params.source,
          targetId: params.target,
          type: "sequence",
        })
        .catch(() => {});
    },
    [workflowId, setEdges],
  );

  // Add node from palette drop
  const addNode = useCallback(
    (type: string, subType: string | undefined, position: { x: number; y: number }) => {
      const id = `bpmn-el-${crypto.randomUUID()}`;

      // Determine element properties based on type
      let elementType = type;
      let eventPosition: string | undefined;
      let taskType: string | undefined;
      let gatewayType: string | undefined;
      let size = { w: 160, h: 80 };

      if (type === "startEvent") {
        elementType = "startEvent";
        eventPosition = "start";
        size = { w: 40, h: 40 };
      } else if (type === "endEvent") {
        elementType = "endEvent";
        eventPosition = "end";
        size = { w: 40, h: 40 };
      } else if (type === "task") {
        taskType = subType || "user";
      } else if (type === "gateway") {
        gatewayType = subType || "exclusive";
        size = { w: 50, h: 50 };
      }

      const element: BpmnElement = {
        id,
        workflowId,
        type: elementType as BpmnElement["type"],
        name: subType
          ? `${subType.charAt(0).toUpperCase() + subType.slice(1)} ${type === "gateway" ? "Gateway" : "Task"}`
          : type === "startEvent"
            ? ""
            : type === "endEvent"
              ? ""
              : "New Element",
        position,
        size,
        eventPosition: eventPosition as BpmnElement["eventPosition"],
        taskType: taskType as BpmnElement["taskType"],
        gatewayType: gatewayType as BpmnElement["gatewayType"],
      };

      const node = elementToNode(element);

      // Undo/redo command
      commandStack.execute({
        type: "addNode",
        execute: () => {
          setNodes((nds) => [...nds, node]);
        },
        undo: () => {
          setNodes((nds) => nds.filter((n) => n.id !== id));
        },
      });

      setIsDirty(true);

      // Persist to backend
      api
        .addElement(workflowId, {
          id,
          type: elementType,
          name: element.name,
          position,
          size,
          eventPosition,
          taskType,
          gatewayType,
        })
        .catch(() => {});
    },
    [workflowId, setNodes, commandStack],
  );

  // Delete selected nodes/edges
  const deleteSelected = useCallback(() => {
    setNodes((nds) => {
      const selectedNodes = nds.filter((n) => n.selected);
      for (const node of selectedNodes) {
        api.deleteElement(workflowId, node.id).catch(() => {});
      }
      return nds.filter((n) => !n.selected);
    });
    setEdges((eds) => {
      const selectedEdges = eds.filter((e) => e.selected);
      for (const edge of selectedEdges) {
        api.deleteFlow(workflowId, edge.id).catch(() => {});
      }
      return eds.filter((e) => !e.selected);
    });
    setIsDirty(true);
  }, [workflowId, setNodes, setEdges]);

  // Update node data (from detail panel)
  const updateNodeData = useCallback(
    (nodeId: string, updates: Record<string, unknown>) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== nodeId) return n;
          const prev = n.data as Record<string, unknown>;
          const prevElement = prev.element as Record<string, unknown>;
          return {
            ...n,
            data: { ...prev, element: { ...prevElement, ...updates } },
          };
        }),
      );
      setIsDirty(true);
      api.updateElement(workflowId, nodeId, updates).catch(() => {});
    },
    [workflowId, setNodes],
  );

  // Undo/redo
  const undo = useCallback(() => {
    commandStack.undo();
  }, [commandStack]);

  const redo = useCallback(() => {
    commandStack.redo();
  }, [commandStack]);

  // Save (force-refresh from backend)
  const save = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: ["bpmn-workflow", workflowId],
    });
    setIsDirty(false);
  }, [queryClient, workflowId]);

  // Validate
  const validate = useCallback(async () => {
    try {
      const result = await api.validateWorkflow(workflowId);
      setValidationErrors(result.errors);

      // Mark invalid nodes
      setNodes((nds) =>
        nds.map((n) => {
          const prev = n.data as Record<string, unknown>;
          return {
            ...n,
            data: {
              ...prev,
              invalid: result.errors.some((e: BpmnValidationError) => e.elementId === n.id),
            },
          };
        }),
      );

      return result;
    } catch {
      return { valid: false, errors: [] as BpmnValidationError[] };
    }
  }, [workflowId, setNodes]);

  return {
    nodes,
    edges,
    onNodesChange: handleNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    deleteSelected,
    updateNodeData,
    undo,
    redo,
    canUndo: commandStack.canUndo,
    canRedo: commandStack.canRedo,
    isDirty,
    save,
    validate,
    validationErrors,
    workflow,
    isLoading,
    error,
  };
}
