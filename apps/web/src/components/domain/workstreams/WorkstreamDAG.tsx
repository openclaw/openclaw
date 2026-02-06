"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  type EdgeTypes,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./dag-dark-theme.css";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Plus,
  LayoutGrid,
  RotateCcw,
  Maximize2,
  Keyboard,
  Focus,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import type { Task, TaskStatus, TaskPriority } from "@/hooks/queries/useWorkstreams";
import type { WorkQueueItem } from "@/hooks/queries/useWorkQueue";
import type { Agent } from "@/stores/useAgentStore";
import { TaskNode } from "./TaskNode";
import { AvoidingEdge } from "./AvoidingEdge";

// Register custom node types
const nodeTypes: NodeTypes = {
  taskNode: TaskNode,
};

// Register custom edge types
const edgeTypes: EdgeTypes = {
  avoiding: AvoidingEdge,
};

type TaskRelationType = "upstream" | "downstream";

interface NewTaskData {
  title: string;
  description: string;
  priority: TaskPriority;
  relationType: TaskRelationType;
  relatedTaskId: string;
}

interface WorkstreamDAGProps {
  tasks: Task[];
  agents?: Agent[];
  queueItems?: WorkQueueItem[];
  onTaskClick?: (task: Task) => void;
  onAddTask?: () => void;
  /** Called when a new task is created via context menu */
  onCreateRelatedTask?: (data: NewTaskData) => void;
  className?: string;
}

// Layout configuration - generous spacing for readability
const HORIZONTAL_SPACING = 380;
const VERTICAL_SPACING = 240;

// Simple dagre-like layout algorithm
function layoutNodes(tasks: Task[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  if (tasks.length === 0) {return positions;}

  // Build dependency graph
  const dependencyMap = new Map<string, Set<string>>();
  const dependentMap = new Map<string, Set<string>>();

  for (const task of tasks) {
    dependencyMap.set(task.id, new Set(task.dependencies || []));
    if (!dependentMap.has(task.id)) {
      dependentMap.set(task.id, new Set());
    }
    for (const depId of task.dependencies || []) {
      if (!dependentMap.has(depId)) {
        dependentMap.set(depId, new Set());
      }
      dependentMap.get(depId)?.add(task.id);
    }
  }

  // Calculate levels using topological sort
  const levels = new Map<string, number>();
  const visited = new Set<string>();

  function calculateLevel(taskId: string): number {
    if (levels.has(taskId)) {return levels.get(taskId)!;}
    if (visited.has(taskId)) {return 0;} // Cycle detection

    visited.add(taskId);
    const deps = dependencyMap.get(taskId) || new Set();

    if (deps.size === 0) {
      levels.set(taskId, 0);
      return 0;
    }

    let maxDepLevel = 0;
    for (const depId of deps) {
      if (tasks.find(t => t.id === depId)) {
        maxDepLevel = Math.max(maxDepLevel, calculateLevel(depId) + 1);
      }
    }

    levels.set(taskId, maxDepLevel);
    return maxDepLevel;
  }

  // Calculate levels for all tasks
  for (const task of tasks) {
    calculateLevel(task.id);
  }

  // Group tasks by level
  const levelGroups = new Map<number, string[]>();
  for (const task of tasks) {
    const level = levels.get(task.id) || 0;
    if (!levelGroups.has(level)) {
      levelGroups.set(level, []);
    }
    levelGroups.get(level)?.push(task.id);
  }

  // Assign positions
  const sortedLevels = Array.from(levelGroups.keys()).toSorted((a, b) => a - b);

  for (const level of sortedLevels) {
    const taskIds = levelGroups.get(level) || [];
    const levelWidth = taskIds.length * HORIZONTAL_SPACING;
    const startX = -levelWidth / 2 + HORIZONTAL_SPACING / 2;

    taskIds.forEach((taskId, index) => {
      positions.set(taskId, {
        x: startX + index * HORIZONTAL_SPACING,
        y: level * VERTICAL_SPACING,
      });
    });
  }

  return positions;
}

// Node dimensions for intersection detection
const NODE_WIDTH = 260;
const NODE_HEIGHT = 180; // Approximate height including padding

// Check if a line segment intersects a rectangle (node bounding box)
function lineIntersectsRect(
  x1: number, y1: number, // Line start
  x2: number, y2: number, // Line end
  rx: number, ry: number, // Rect top-left
  rw: number, rh: number  // Rect width/height
): boolean {
  // Add padding around the rectangle for better detection
  const padding = 20;
  const left = rx - padding;
  const right = rx + rw + padding;
  const top = ry - padding;
  const bottom = ry + rh + padding;

  // Check if line segment intersects with any of the 4 edges of the rectangle
  // Using parametric line intersection

  // Helper: check if line segment (x1,y1)-(x2,y2) intersects line segment (x3,y3)-(x4,y4)
  const segmentsIntersect = (
    ax1: number, ay1: number, ax2: number, ay2: number,
    bx1: number, by1: number, bx2: number, by2: number
  ): boolean => {
    const d = (ax2 - ax1) * (by2 - by1) - (ay2 - ay1) * (bx2 - bx1);
    if (Math.abs(d) < 0.0001) {return false;} // Parallel

    const t = ((bx1 - ax1) * (by2 - by1) - (by1 - ay1) * (bx2 - bx1)) / d;
    const u = -((ax2 - ax1) * (by1 - ay1) - (ay2 - ay1) * (bx1 - ax1)) / d;

    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };

  // Check intersection with all 4 edges of the rectangle
  return (
    segmentsIntersect(x1, y1, x2, y2, left, top, right, top) ||     // Top
    segmentsIntersect(x1, y1, x2, y2, left, bottom, right, bottom) || // Bottom
    segmentsIntersect(x1, y1, x2, y2, left, top, left, bottom) ||   // Left
    segmentsIntersect(x1, y1, x2, y2, right, top, right, bottom)    // Right
  );
}

// Obstacle data structure for custom edge routing
interface ObstacleNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Check if an edge path would intersect any node and calculate routing info
function getEdgeRoutingInfo(
  sourcePos: { x: number; y: number },
  targetPos: { x: number; y: number },
  allPositions: Map<string, { x: number; y: number }>,
  sourceId: string,
  targetId: string
): {
  wouldIntersect: boolean;
  offset: number;
  routeDirection: "left" | "right" | "none";
  obstacles: ObstacleNode[];
} {
  let wouldIntersect = false;
  let maxOffset = 0;
  let routeDirection: "left" | "right" | "none" = "none";

  // Source and target center points
  const sourceX = sourcePos.x + NODE_WIDTH / 2;
  const sourceY = sourcePos.y + NODE_HEIGHT;
  const targetX = targetPos.x + NODE_WIDTH / 2;
  const targetY = targetPos.y;

  // Find all nodes that would be intersected
  const obstacles: ObstacleNode[] = [];

  for (const [nodeId, nodePos] of allPositions) {
    if (nodeId === sourceId || nodeId === targetId) {continue;}

    if (lineIntersectsRect(
      sourceX, sourceY,
      targetX, targetY,
      nodePos.x, nodePos.y,
      NODE_WIDTH, NODE_HEIGHT
    )) {
      wouldIntersect = true;
      obstacles.push({
        x: nodePos.x,
        y: nodePos.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    }
  }

  if (wouldIntersect && obstacles.length > 0) {
    // Calculate the bounding box of all intersected nodes
    const minX = Math.min(...obstacles.map(n => n.x));
    const maxX = Math.max(...obstacles.map(n => n.x + n.width));

    // Determine best route direction based on source/target positions
    const edgeMidX = (sourceX + targetX) / 2;
    const obstacleMidX = (minX + maxX) / 2;

    if (sourceX < obstacleMidX && targetX < obstacleMidX) {
      // Both source and target are to the left - route further left
      routeDirection = "left";
      maxOffset = Math.max(sourceX, targetX) - minX + 30;
    } else if (sourceX > obstacleMidX && targetX > obstacleMidX) {
      // Both source and target are to the right - route further right
      routeDirection = "right";
      maxOffset = maxX - Math.min(sourceX, targetX) + 30;
    } else {
      // Source and target are on opposite sides
      // Route around whichever side has more space
      const spaceLeft = Math.min(sourceX, targetX) - minX;
      const spaceRight = maxX - Math.max(sourceX, targetX);

      if (spaceLeft > spaceRight) {
        routeDirection = "left";
        maxOffset = Math.abs(edgeMidX - minX) + 40;
      } else {
        routeDirection = "right";
        maxOffset = Math.abs(maxX - edgeMidX) + 40;
      }
    }
  }

  return { wouldIntersect, offset: maxOffset, routeDirection, obstacles };
}

// Convert tasks to ReactFlow nodes and edges
function tasksToFlow(
  tasks: Task[],
  agents: Agent[],
  queueItems: WorkQueueItem[] = [],
  layoutDirection: "horizontal" | "vertical" = "vertical"
): { nodes: Node[]; edges: Edge[] } {
  const positions = layoutNodes(tasks);
  const queueItemMap = new Map(
    queueItems
      .filter((item) => item.taskId)
      .map((item) => [item.taskId as string, item])
  );

  const nodes: Node[] = tasks.map((task) => {
    const position = positions.get(task.id) || { x: 0, y: 0 };
    const agent = agents.find((a) => a.id === task.assigneeId);
    const queueItem = queueItemMap.get(task.id);

    return {
      id: task.id,
      position,
      data: {
        task,
        agent,
        queueItem,
        layoutDirection, // Pass to node for handle positioning
      },
      type: "taskNode",
    };
  });

  // Edge color mapping for status - matches TaskNode theme colors
  const getEdgeColor = (sourceStatus: TaskStatus, targetStatus: TaskStatus) => {
    if (targetStatus === "blocked") {return "#ef4444";} // destructive
    if (sourceStatus === "done" && targetStatus === "done") {return "#22c55e";} // success
    if (targetStatus === "in_progress") {return "#3b82f6";} // primary
    if (targetStatus === "review") {return "#f97316";} // warning
    return "#64748b"; // muted
  };

  const edges: Edge[] = tasks.flatMap((task) =>
    (task.dependencies || [])
      .filter((depId) => tasks.find((t) => t.id === depId))
      .map((depId) => {
        const sourceTask = tasks.find((t) => t.id === depId);
        const isActive = task.status === "in_progress" || task.status === "review";
        const edgeColor = getEdgeColor(sourceTask?.status ?? "todo", task.status);

        // Get positions
        const sourcePos = positions.get(depId) || { x: 0, y: 0 };
        const targetPos = positions.get(task.id) || { x: 0, y: 0 };

        // Check if edge would intersect any intermediate nodes and get routing info
        const { wouldIntersect, offset, routeDirection, obstacles } = getEdgeRoutingInfo(
          sourcePos, targetPos, positions, depId, task.id
        );

        // Use custom "avoiding" edge for obstacle avoidance, otherwise default bezier
        const edgeType = wouldIntersect ? "avoiding" : "default";

        // Base edge config
        const edge: Edge = {
          id: `${depId}-${task.id}`,
          source: depId,
          target: task.id,
          type: edgeType,
          animated: isActive,
          style: {
            stroke: edgeColor,
            strokeWidth: 2,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: edgeColor,
          },
        };

        // Pass obstacle data to the custom edge for routing
        if (wouldIntersect) {
          edge.data = {
            obstacles,
            routeDirection,
            clearanceOffset: Math.max(offset, 30),
          };
        }

        return edge;
      })
  );

  return { nodes, edges };
}

function WorkstreamDAGInner({
  tasks,
  agents = [],
  queueItems = [],
  onTaskClick,
  onAddTask,
  onCreateRelatedTask,
  className,
}: WorkstreamDAGProps) {
  const { fitView } = useReactFlow();
  const [layoutDirection, setLayoutDirection] = useState<"horizontal" | "vertical">("vertical");

  // Context menu state
  const [contextMenuTask, setContextMenuTask] = useState<Task | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);

  // Modal state for adding related task
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [relationType, setRelationType] = useState<TaskRelationType>("downstream");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDescription, setNewTaskDescription] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState<TaskPriority>("medium");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Open modal for adding related task
  const handleOpenAddTaskModal = useCallback((task: Task, type: TaskRelationType) => {
    setContextMenuTask(task);
    setRelationType(type);
    setNewTaskTitle("");
    setNewTaskDescription("");
    setNewTaskPriority("medium");
    setIsModalOpen(true);
  }, []);

  // Submit new task
  const handleSubmitNewTask = useCallback(() => {
    if (!contextMenuTask || !newTaskTitle.trim()) {return;}

    onCreateRelatedTask?.({
      title: newTaskTitle.trim(),
      description: newTaskDescription.trim(),
      priority: newTaskPriority,
      relationType,
      relatedTaskId: contextMenuTask.id,
    });

    setIsModalOpen(false);
    setContextMenuTask(null);
    setNewTaskTitle("");
    setNewTaskDescription("");
  }, [contextMenuTask, newTaskTitle, newTaskDescription, newTaskPriority, relationType, onCreateRelatedTask]);

  const initialFlow = useMemo(
    () => tasksToFlow(tasks, agents, queueItems),
    [tasks, agents, queueItems]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlow.edges);

  const applySelection = useCallback((nextNodes: Node[], taskId: string | null) => {
    if (!taskId) {
      return nextNodes.map((node) => ({ ...node, selected: false }));
    }
    return nextNodes.map((node) => ({ ...node, selected: node.id === taskId }));
  }, []);

  const setSelectedTask = useCallback((taskId: string | null) => {
    setSelectedTaskId(taskId);
    setNodes((currentNodes: Node[]) => applySelection(currentNodes, taskId));
  }, [applySelection, setNodes]);

  const handleResetView = useCallback(() => {
    fitView({ padding: 0.2, duration: 300 });
  }, [fitView]);

  // Focus on active/in-progress tasks (zoom + center)
  const handleFocusActive = useCallback(() => {
    // Find active tasks (in_progress or review)
    const activeTasks = tasks.filter(
      (t) => t.status === "in_progress" || t.status === "review"
    );

    if (activeTasks.length === 0) {
      // No active tasks, focus on blocked or todo
      const nextTasks = tasks.filter(
        (t) => t.status === "blocked" || t.status === "todo"
      );
      if (nextTasks.length > 0) {
        fitView({
          nodes: nextTasks.map((t) => ({ id: t.id })),
          padding: 0.3,
          duration: 500,
          maxZoom: 1,
        });
        setSelectedTask(nextTasks[0].id);
      }
      return;
    }

    // Focus on active tasks
    fitView({
      nodes: activeTasks.map((t) => ({ id: t.id })),
      padding: 0.3,
      duration: 500,
      maxZoom: 1,
    });
    setSelectedTask(activeTasks[0].id);
  }, [tasks, fitView, setSelectedTask]);

  // Update nodes when tasks change
  useEffect(() => {
    const flow = tasksToFlow(tasks, agents, queueItems);
    setNodes(applySelection(flow.nodes, selectedTaskId));
    setEdges(flow.edges);
  }, [tasks, agents, queueItems, setNodes, setEdges, selectedTaskId, applySelection]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds: Edge[]) => addEdge(params, eds)),
    [setEdges]
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const task = tasks.find((t) => t.id === node.id);
      setSelectedTask(node.id);
      if (task) {
        onTaskClick?.(task);
      }
    },
    [tasks, onTaskClick, setSelectedTask]
  );

  // Handle right-click on node for context menu
  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      event.stopPropagation();
      const task = tasks.find((t) => t.id === node.id);
      if (task) {
        setContextMenuTask(task);
        setContextMenuPosition({ x: event.clientX, y: event.clientY });
      }
    },
    [tasks]
  );

  // Handle right-click on pane (not on node) - close menu and prevent browser menu
  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault();
      // Close the custom menu when right-clicking elsewhere
      setContextMenuPosition(null);
      setContextMenuTask(null);
    },
    []
  );

  const toggleLayout = useCallback(() => {
    const newDirection = layoutDirection === "horizontal" ? "vertical" : "horizontal";
    setLayoutDirection(newDirection);

    // Get flow with the new direction for proper handle positions
    const flow = tasksToFlow(tasks, agents, queueItems, newDirection);

    if (newDirection === "horizontal") {
      // For horizontal layout: swap X and Y, and scale appropriately
      // In horizontal mode, levels go left-to-right, nodes stack vertically within a level
      const horizontalNodes = flow.nodes.map((node) => ({
        ...node,
        position: {
          x: node.position.y * 1.5, // Levels spread out horizontally
          y: node.position.x * 0.8, // Nodes within level stack vertically
        },
      }));
      setNodes(applySelection(horizontalNodes, selectedTaskId));
    } else {
      setNodes(applySelection(flow.nodes, selectedTaskId));
    }
    setEdges(flow.edges);

    // Fit view after layout change
    setTimeout(() => {
      fitView({ padding: 0.2, duration: 300 });
    }, 50);
  }, [layoutDirection, tasks, agents, selectedTaskId, applySelection, setNodes, setEdges, fitView]);

  const resetLayout = useCallback(() => {
    setLayoutDirection("vertical"); // Reset to vertical mode
    const flow = tasksToFlow(tasks, agents, queueItems, "vertical");
    setNodes(applySelection(flow.nodes, selectedTaskId));
    setEdges(flow.edges);
    setSelectedTask(null);

    // Fit view after reset
    setTimeout(() => {
      fitView({ padding: 0.2, duration: 300 });
    }, 50);
  }, [tasks, agents, selectedTaskId, applySelection, setNodes, setEdges, fitView, setSelectedTask]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedTask(null);
      }
      // Press 'f' to focus active
      if (e.key === "f" && !e.metaKey && !e.ctrlKey) {
        handleFocusActive();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleFocusActive, setSelectedTask]);

  // Auto-focus on active tasks on initial render
  const [hasAutoFocused, setHasAutoFocused] = useState(false);
  useEffect(() => {
    if (!hasAutoFocused && tasks.length > 0) {
      // Small delay to ensure ReactFlow is ready
      const timer = setTimeout(() => {
        handleFocusActive();
        setHasAutoFocused(true);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [tasks.length, hasAutoFocused, handleFocusActive]);

  return (
    <Card className={cn("relative overflow-hidden", className)}>
      {/* Top toolbar - matching WorkflowVisualization */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card/30 px-3 py-2">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={toggleLayout}
            className="gap-2"
          >
            <LayoutGrid className="size-4" />
            {layoutDirection === "vertical" ? "Horizontal" : "Vertical"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={resetLayout}
            className="gap-2"
          >
            <RotateCcw className="size-4" />
            Reset
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleResetView}
            className="gap-2"
          >
            <Maximize2 className="size-4" />
            Reset View
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={handleFocusActive}
            className="gap-2"
          >
            <Focus className="size-4" />
            Focus Active
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {onAddTask && (
            <Button size="sm" onClick={onAddTask} className="gap-2">
              <Plus className="size-4" />
              Add Task
            </Button>
          )}
        </div>
      </div>

      {/* ReactFlow container - matching WorkflowVisualization height */}
      <div className="h-[65vh] min-h-[520px]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={handleNodeClick}
          onNodeContextMenu={handleNodeContextMenu}
          onPaneContextMenu={handlePaneContextMenu}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={true}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          panOnScroll
          zoomOnScroll
          zoomOnPinch
          minZoom={0.1}
          maxZoom={2}
          className="bg-background"
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={16}
            size={1}
          />

          <Controls
            showInteractive={false}
            className="bg-card border border-border rounded-lg shadow-md"
          />

          <MiniMap
            className="bg-card border border-border rounded-lg shadow-md"
            nodeColor={(node) => {
              const task = node.data?.task as Task | undefined;
              if (!task) {return "#64748b";}
              switch (task.status) {
                case "done":
                  return "#22c55e";
                case "in_progress":
                  return "#3b82f6";
                case "blocked":
                  return "#ef4444";
                case "review":
                  return "#f97316";
                default:
                  return "#64748b";
              }
            }}
            maskColor="hsl(var(--background) / 0.8)"
            pannable
            zoomable
          />
        </ReactFlow>
      </div>

      {/* Bottom toolbar - matching WorkflowVisualization */}
      <div className="flex items-center justify-between gap-2 border-t border-border bg-card/30 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Keyboard className="size-3" />
          <span>
            <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono">F</kbd> focus active
          </span>
          <span className="text-muted-foreground/50">|</span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono">Esc</kbd> clear
          </span>
          <span className="text-muted-foreground/50">|</span>
          <span className="text-muted-foreground">Right-click node to add task</span>
        </div>

        {/* Legend - inline in bottom toolbar */}
        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5">
            <div className="size-2.5 rounded-full bg-muted-foreground" />
            <span className="text-muted-foreground">To Do</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="size-2.5 rounded-full bg-primary" />
            <span className="text-muted-foreground">In Progress</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="size-2.5 rounded-full bg-[color:var(--warning)]" />
            <span className="text-muted-foreground">Review</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="size-2.5 rounded-full bg-[color:var(--success)]" />
            <span className="text-muted-foreground">Done</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="size-2.5 rounded-full bg-destructive" />
            <span className="text-muted-foreground">Blocked</span>
          </div>
        </div>
      </div>

      {/* Context menu - positioned absolutely */}
      {contextMenuPosition && contextMenuTask && (
        <div
          className="fixed z-50 min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-lg"
          style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
          onClick={() => setContextMenuPosition(null)}
        >
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted/80"
            onClick={() => {
              handleOpenAddTaskModal(contextMenuTask, "upstream");
              setContextMenuPosition(null);
            }}
          >
            <ArrowUp className="size-4" />
            Add Upstream Dependency
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted/80"
            onClick={() => {
              handleOpenAddTaskModal(contextMenuTask, "downstream");
              setContextMenuPosition(null);
            }}
          >
            <ArrowDown className="size-4" />
            Add Downstream Task
          </button>
        </div>
      )}

      {/* Click outside to close context menu */}
      {contextMenuPosition && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setContextMenuPosition(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenuPosition(null);
            setContextMenuTask(null);
          }}
        />
      )}

      {/* Modal for adding related task */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>
              {relationType === "upstream" ? "Add Upstream Dependency" : "Add Downstream Task"}
            </DialogTitle>
            <DialogDescription>
              {relationType === "upstream"
                ? `Create a new task that "${contextMenuTask?.title}" will depend on.`
                : `Create a new task that depends on "${contextMenuTask?.title}".`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="title">Task Title</Label>
              <Input
                id="title"
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                placeholder="Enter task title..."
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={newTaskDescription}
                onChange={(e) => setNewTaskDescription(e.target.value)}
                placeholder="Enter task description..."
                rows={3}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="priority">Priority</Label>
              <Select value={newTaskPriority} onValueChange={(v) => setNewTaskPriority(v as TaskPriority)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmitNewTask} disabled={!newTaskTitle.trim()}>
              Create Task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function WorkstreamDAG(props: WorkstreamDAGProps) {
  return (
    <ReactFlowProvider>
      <WorkstreamDAGInner {...props} />
    </ReactFlowProvider>
  );
}

export type { NewTaskData, TaskRelationType };
export default WorkstreamDAG;
