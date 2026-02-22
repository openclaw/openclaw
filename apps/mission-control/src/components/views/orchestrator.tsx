"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Zap,
  Plus,
  Trash2,
  Bot,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Rocket,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getPriorityColor } from "@/lib/shared";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"; // used in Save as Mission modal below
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useGatewayConnectionState,
  useGatewayEvents,
  type GatewayConnectionState,
  type GatewayEvent,
} from "@/lib/hooks/use-gateway-events";

// --- Types ---

interface Agent {
  id: string;
  name?: string;
  model?: string;
}

interface TaskDef {
  id: string;
  title: string;
  description: string;
  priority: string;
  agentId: string;
}

interface ActiveTask {
  id: string;
  title: string;
  status: string;
  assigned_agent_id: string | null;
  priority: string;
  monitoring?: boolean;
  elapsedMs?: number;
  created_at: string;
  updated_at: string;
}

interface CompletedTask {
  id: string;
  title: string;
  status: string;
  assigned_agent_id: string | null;
  priority: string;
  updated_at: string;
}

interface BatchResult {
  batchId: string;
  total: number;
  dispatched: number;
  failed: number;
  results: Array<{
    taskId: string;
    title: string;
    agentId: string;
    status: "dispatched" | "failed";
    error?: string;
  }>;
}

// --- Templates ---

const TEMPLATES: Array<{
  name: string;
  icon: string;
  tasks: Array<{ title: string; description: string; priority: string }>;
}> = [
    {
      name: "Research & Report",
      icon: "🔍",
      tasks: [
        {
          title: "Research the topic",
          description:
            "Do comprehensive research on the given topic. Find key facts, statistics, and expert opinions.",
          priority: "high",
        },
        {
          title: "Write the report",
          description:
            "Based on the research findings, write a clear, well-structured report with an executive summary.",
          priority: "high",
        },
        {
          title: "Review and fact-check",
          description:
            "Review the report for accuracy. Verify all claims and statistics. Fix any errors.",
          priority: "medium",
        },
      ],
    },
    {
      name: "Code Feature",
      icon: "💻",
      tasks: [
        {
          title: "Plan the implementation",
          description:
            "Analyze the codebase and create a detailed implementation plan for the new feature.",
          priority: "high",
        },
        {
          title: "Write the code",
          description:
            "Implement the feature following the plan. Write clean, well-documented code.",
          priority: "high",
        },
        {
          title: "Write tests",
          description:
            "Write comprehensive unit and integration tests for the new feature.",
          priority: "medium",
        },
      ],
    },
    {
      name: "Content Pipeline",
      icon: "📝",
      tasks: [
        {
          title: "Generate content ideas",
          description:
            "Brainstorm 10 content ideas for the given topic. Include titles, angles, and target audiences.",
          priority: "medium",
        },
        {
          title: "Write first draft",
          description:
            "Write a compelling first draft based on the best content idea. Focus on value and engagement.",
          priority: "high",
        },
        {
          title: "Edit and polish",
          description:
            "Edit the draft for clarity, grammar, and flow. Make it publication-ready.",
          priority: "medium",
        },
        {
          title: "Create social media posts",
          description:
            "Create 5 social media posts to promote the content across different platforms.",
          priority: "low",
        },
      ],
    },
    {
      name: "Competitive Analysis",
      icon: "📊",
      tasks: [
        {
          title: "Identify competitors",
          description:
            "Find and list the top 5-10 competitors in the space. Include their key offerings and positioning.",
          priority: "high",
        },
        {
          title: "Analyze strengths & weaknesses",
          description:
            "For each competitor, analyze their strengths, weaknesses, pricing, and market position.",
          priority: "high",
        },
        {
          title: "Summarize opportunities",
          description:
            "Based on the analysis, identify gaps and opportunities. Provide strategic recommendations.",
          priority: "medium",
        },
      ],
    },
  ];

// --- Helpers ---

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) { return `${seconds}s`; }
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

let nextLocalId = 1;

// --- Main Component ---

interface OrchestratorProps {
  workspaceId: string;
}

export function Orchestrator({ workspaceId }: OrchestratorProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [taskDefs, setTaskDefs] = useState<TaskDef[]>([]);
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);
  const [completedTasks, setCompletedTasks] = useState<CompletedTask[]>([]);
  const [launching, setLaunching] = useState(false);
  const [lastBatch, setLastBatch] = useState<BatchResult | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [monitorCount, setMonitorCount] = useState(0);
  const [connectionState, setConnectionState] =
    useState<GatewayConnectionState>("connecting");
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [savingMission, setSavingMission] = useState(false);
  const [showSaveMissionModal, setShowSaveMissionModal] = useState(false);
  const [newMissionName, setNewMissionName] = useState("");
  const [newMissionDesc, setNewMissionDesc] = useState("");

  // Hydrate queue from localStorage (sent from MissionsView)
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("mission-control:orchestrator-queue");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const freshTasks: TaskDef[] = (
            parsed as { title?: string; description?: string; priority?: string; agentId?: string }[]
          ).map((t) => ({
            id: `local-${nextLocalId++}`,
            title: t.title || "Untitled",
            description: t.description || "",
            priority: t.priority || "medium",
            agentId: t.agentId || "",
          }));
          setTaskDefs(freshTasks);
        }
        window.localStorage.removeItem("mission-control:orchestrator-queue");
      }
    } catch {
      // Ignore
    }
  }, []);

  // Fetch agents on mount
  useEffect(() => {
    fetch("/api/agents")
      .then((r) => {
        if (!r.ok) { throw new Error(`HTTP ${r.status}`); }
        return r.json();
      })
      .then((d) => setAgents(d.agents || []))
      .catch(() => { });
  }, []);

  // Poll orchestrator status
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/orchestrator");
      const data = await res.json();
      setActiveTasks(data.active || []);
      setCompletedTasks(data.completed || []);
      setMonitorCount(data.monitorCount || 0);
    } catch {
      /* ignore */
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) { return; }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      fetchStatus().catch(() => {
        // Ignore transient status refresh failures.
      });
    }, 200);
  }, [fetchStatus]);

  const handleConnectionState = useCallback((state: GatewayConnectionState) => {
    setConnectionState(state);
  }, []);

  const handleGatewayEvent = useCallback(
    (event: GatewayEvent) => {
      if (event.type !== "gateway_event") { return; }
      const eventName = (event.event || "").toLowerCase();
      if (
        eventName.includes("orchestrator") ||
        eventName.includes("task") ||
        eventName.includes("chat.") ||
        eventName.includes("sessions.") ||
        eventName.includes("status")
      ) {
        scheduleRefresh();
      }
    },
    [scheduleRefresh]
  );

  useGatewayConnectionState(handleConnectionState);
  useGatewayEvents(handleGatewayEvent);

  useEffect(() => {
    fetchStatus().catch(() => {
      // Ignore initial load failures.
    });
  }, [fetchStatus]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      if (connectionState !== "connected") {
        fetchStatus().catch(() => {
          // Ignore fallback status refresh failures.
        });
      }
    }, 15_000);
    return () => clearInterval(intervalId);
  }, [connectionState, fetchStatus]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  // Add a blank task definition
  const addTask = () => {
    setTaskDefs((prev) => [
      ...prev,
      {
        id: `local-${nextLocalId++}`,
        title: "",
        description: "",
        priority: "medium",
        agentId: agents[0]?.id || "",
      },
    ]);
  };

  // Remove a task definition
  const removeTask = (id: string) => {
    setTaskDefs((prev) => prev.filter((t) => t.id !== id));
  };

  // Update a task definition field
  const updateTaskDef = (
    id: string,
    field: keyof TaskDef,
    value: string
  ) => {
    setTaskDefs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, [field]: value } : t))
    );
  };

  // Load a template
  const loadTemplate = (template: (typeof TEMPLATES)[number]) => {
    const defaultAgent = agents[0]?.id || "";
    const newTasks: TaskDef[] = template.tasks.map((t) => ({
      id: `local-${nextLocalId++}`,
      title: t.title,
      description: t.description,
      priority: t.priority,
      agentId: defaultAgent,
    }));
    setTaskDefs((prev) => [...prev, ...newTasks]);
    setShowTemplates(false);
  };

  // Launch all tasks
  const launchAll = async () => {
    const valid = taskDefs.filter((t) => t.title.trim() && t.agentId);
    if (valid.length === 0) { return; }

    setLaunching(true);
    setLastBatch(null);

    try {
      const res = await fetch("/api/orchestrator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: valid.map((t) => ({
            title: t.title.trim(),
            description: t.description.trim(),
            priority: t.priority,
            agentId: t.agentId,
          })),
          workspace_id: workspaceId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setLastBatch(data);
      setTaskDefs([]); // Clear the queue
      await fetchStatus(); // Refresh status immediately
    } catch {
      setLastBatch({
        batchId: "error",
        total: 0,
        dispatched: 0,
        failed: valid.length,
        results: [],
      });
    }
    setLaunching(false);
  };

  const saveQueueAsMission = async () => {
    if (!newMissionName.trim() || taskDefs.length === 0) { return; }
    setSavingMission(true);
    try {
      const valid = taskDefs.filter((t) => t.title.trim() && t.agentId);
      const res = await fetch("/api/missions/save-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newMissionName.trim(),
          description: newMissionDesc.trim(),
          workspace_id: workspaceId,
          tasks: valid.map((t) => ({
            title: t.title.trim(),
            description: t.description.trim(),
            priority: t.priority,
            agentId: t.agentId,
          })),
        }),
      });
      if (!res.ok) { throw new Error("Failed to save mission"); }
      setShowSaveMissionModal(false);
      setNewMissionName("");
      setNewMissionDesc("");
      // Optionally show a success toast here if connected to app context
      // But for now, just silently succeed and close modal.
      setTaskDefs([]);
    } catch {
      // Ignore
    } finally {
      setSavingMission(false);
    }
  };

  const validCount = taskDefs.filter(
    (t) => t.title.trim() && t.agentId
  ).length;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center">
            <Zap className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Multi-Agent Orchestrator
            </h2>
            <p className="text-xs text-muted-foreground">
              Dispatch parallel tasks to multiple agents simultaneously
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {monitorCount > 0 && (
            <Badge
              variant="outline"
              className="gap-1.5 text-primary border-primary/30 bg-primary/5"
            >
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              {monitorCount} running
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={fetchStatus}
            className="gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6">
          {/* === Task Queue === */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm uppercase tracking-wide">
                  Task Queue
                </h3>
                {taskDefs.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono border border-primary/20">
                    {taskDefs.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowTemplates(!showTemplates)}
                  className="gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Templates
                  {showTemplates ? (
                    <ChevronUp className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )}
                </Button>
                <Button size="sm" onClick={addTask} className="gap-1.5">
                  <Plus className="w-3.5 h-3.5" />
                  Add Task
                </Button>
              </div>
            </div>

            {/* Templates Dropdown */}
            {showTemplates && (
              <div className="mb-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
                {TEMPLATES.map((tmpl) => (
                  <button
                    key={tmpl.name}
                    onClick={() => loadTemplate(tmpl)}
                    className="p-4 bg-card border border-border rounded-lg hover:border-primary/50 hover:shadow-[0_0_15px_oklch(0.58_0.2_260/0.1)] transition-all text-left group"
                  >
                    <div className="text-2xl mb-2">{tmpl.icon}</div>
                    <div className="font-medium text-sm">{tmpl.name}</div>
                    <div className="text-[11px] text-muted-foreground mt-1">
                      {tmpl.tasks.length} tasks
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Task Definitions */}
            {taskDefs.length === 0 ? (
              <div className="text-center py-12 bg-card/50 rounded-lg border border-dashed border-border">
                <Zap className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground text-sm mb-1">
                  No tasks in queue
                </p>
                <p className="text-muted-foreground/60 text-xs mb-4">
                  Add tasks manually or use a template to get started
                </p>
                <div className="flex items-center gap-2 justify-center">
                  <Button size="sm" onClick={addTask} className="gap-1.5">
                    <Plus className="w-3.5 h-3.5" />
                    Add Task
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowTemplates(true)}
                    className="gap-1.5"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Use Template
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {taskDefs.map((task, idx) => (
                  <div
                    key={task.id}
                    className="bg-card border border-border rounded-lg p-4 hover:border-primary/30 transition-all relative group"
                  >
                    {/* Task number badge */}
                    <div className="absolute -left-2 -top-2 w-6 h-6 rounded-full bg-primary text-primary-foreground text-[11px] font-bold flex items-center justify-center shadow-[0_0_8px_oklch(0.58_0.2_260/0.3)]">
                      {idx + 1}
                    </div>

                    <div className="flex gap-4">
                      {/* Left: task details */}
                      <div className="flex-1 space-y-3">
                        <input
                          type="text"
                          value={task.title}
                          onChange={(e) =>
                            updateTaskDef(task.id, "title", e.target.value)
                          }
                          placeholder="Task title..."
                          maxLength={200}
                          className="w-full bg-transparent text-sm font-medium text-foreground placeholder:text-muted-foreground/40 outline-none border-b border-transparent focus:border-primary/30 pb-1 transition-colors"
                        />
                        <textarea
                          value={task.description}
                          onChange={(e) =>
                            updateTaskDef(
                              task.id,
                              "description",
                              e.target.value
                            )
                          }
                          placeholder="Description (optional)..."
                          rows={2}
                          maxLength={2000}
                          className="w-full bg-muted/50 rounded-md text-xs text-foreground placeholder:text-muted-foreground/40 outline-none border border-border focus:border-primary/30 px-3 py-2 resize-none transition-colors"
                        />
                      </div>

                      {/* Right: agent + priority + delete */}
                      <div className="flex flex-col gap-2 w-48 shrink-0">
                        <Select
                          value={task.agentId}
                          onValueChange={(v) =>
                            updateTaskDef(task.id, "agentId", v)
                          }
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Agent..." />
                          </SelectTrigger>
                          <SelectContent>
                            {agents.map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                <span className="flex items-center gap-1.5">
                                  <Bot className="w-3 h-3" />
                                  {a.name || a.id}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Select
                          value={task.priority}
                          onValueChange={(v) =>
                            updateTaskDef(task.id, "priority", v)
                          }
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="low">Low</SelectItem>
                            <SelectItem value="medium">Medium</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                            <SelectItem value="urgent">Urgent</SelectItem>
                          </SelectContent>
                        </Select>

                        <button
                          onClick={() => removeTask(task.id)}
                          className="self-end text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Launch Bar */}
                <div className="flex items-center justify-between pt-3 border-t border-border/50">
                  <div className="flex items-center gap-4">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={addTask}
                      className="gap-1.5"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add More
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowSaveMissionModal(true)}
                      disabled={validCount === 0}
                      className="gap-1.5"
                    >
                      <Rocket className="w-3.5 h-3.5" />
                      Save as Mission
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (taskDefs.length > 0 && !confirm("Clear all tasks from the orchestrator?")) { return; }
                        setTaskDefs([]);
                      }}
                      className="text-muted-foreground hover:text-destructive gap-1.5"
                    >
                      <X className="w-3.5 h-3.5" />
                      Clear All
                    </Button>
                  </div>
                  <Button
                    onClick={launchAll}
                    disabled={validCount === 0 || launching}
                    className="gap-2 bg-amber-600 hover:bg-amber-700 text-white shadow-[0_0_15px_oklch(0.7_0.15_70/0.3)]"
                  >
                    {launching ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Dispatching...
                      </>
                    ) : (
                      <>
                        <Rocket className="w-4 h-4" />
                        Launch {validCount} Task
                        {validCount !== 1 ? "s" : ""}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* === Last Batch Result === */}
          {lastBatch && (
            <section className="p-4 rounded-lg border bg-card">
              <div className="flex items-center gap-2 mb-3">
                <h4 className="text-sm font-semibold">
                  Batch: {lastBatch.batchId}
                </h4>
                <Badge
                  variant="outline"
                  className={
                    lastBatch.failed > 0
                      ? "text-destructive border-destructive/30"
                      : "text-green-500 border-green-500/30"
                  }
                >
                  {lastBatch.dispatched}/{lastBatch.total} dispatched
                </Badge>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {lastBatch.results.map((r) => (
                  <div
                    key={r.taskId}
                    className={`flex items-center gap-2 p-2 rounded text-xs font-mono ${r.status === "dispatched"
                      ? "bg-green-500/5 text-green-400"
                      : "bg-destructive/5 text-destructive"
                      }`}
                  >
                    {r.status === "dispatched" ? (
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="truncate">{r.title}</span>
                    <span className="text-muted-foreground ml-auto shrink-0">
                      → {r.agentId}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* === Active Tasks === */}
          {activeTasks.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-4">
                <h3 className="font-semibold text-sm uppercase tracking-wide">
                  Running
                </h3>
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono border border-primary/20">
                  {activeTasks.length}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {activeTasks.map((task) => (
                  <div
                    key={task.id}
                    className="bg-card border border-primary/30 rounded-lg p-4 relative overflow-hidden"
                  >
                    {/* Animated left accent */}
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary" />

                    <div className="pl-3">
                      <div className="flex items-start justify-between mb-2">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${getPriorityColor(task.priority)}`}
                        >
                          {task.priority.toUpperCase()}
                        </Badge>
                        {task.elapsedMs !== undefined && (
                          <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatElapsed(task.elapsedMs)}
                          </span>
                        )}
                      </div>

                      <h4 className="text-sm font-medium mb-2 leading-snug">
                        {task.title}
                      </h4>

                      {/* Progress bar */}
                      <div className="w-full h-1 bg-muted rounded-full overflow-hidden mb-2">
                        <div className="h-full bg-primary animate-pulse w-2/3" />
                      </div>

                      <div className="flex items-center justify-between">
                        {task.assigned_agent_id && (
                          <div className="flex items-center gap-1.5">
                            <div className="relative">
                              <div className="w-5 h-5 rounded-full bg-primary/20 border border-primary flex items-center justify-center">
                                <Bot className="w-2.5 h-2.5 text-primary" />
                              </div>
                              <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-background rounded-full flex items-center justify-center">
                                <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_4px_lime]" />
                              </div>
                            </div>
                            <span className="text-[10px] text-primary font-mono">
                              {task.assigned_agent_id}
                            </span>
                          </div>
                        )}
                        <span className="text-[10px] text-primary font-mono animate-pulse flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Working...
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* === Recently Completed === */}
          {completedTasks.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-4">
                <h3 className="font-semibold text-sm uppercase tracking-wide">
                  Completed
                </h3>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-500 font-mono border border-green-500/20">
                  {completedTasks.length}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {completedTasks.map((task) => (
                  <div
                    key={task.id}
                    className="bg-card border border-green-500/20 rounded-lg p-4 relative overflow-hidden opacity-80 hover:opacity-100 transition-opacity"
                  >
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-green-500" />

                    <div className="pl-3">
                      <div className="flex items-start justify-between mb-2">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${getPriorityColor(task.priority)}`}
                        >
                          {task.priority.toUpperCase()}
                        </Badge>
                        <Badge
                          variant="outline"
                          className="text-[10px] text-green-500 border-green-500/20 bg-green-500/5"
                        >
                          <CheckCircle2 className="w-3 h-3 mr-1" />
                          Review
                        </Badge>
                      </div>

                      <h4 className="text-sm font-medium mb-2 leading-snug">
                        {task.title}
                      </h4>

                      <div className="flex items-center justify-between">
                        {task.assigned_agent_id && (
                          <div className="flex items-center gap-1.5">
                            <div className="w-5 h-5 rounded-full bg-green-500/20 border border-green-500/50 flex items-center justify-center">
                              <Bot className="w-2.5 h-2.5 text-green-400" />
                            </div>
                            <span className="text-[10px] text-green-400 font-mono">
                              {task.assigned_agent_id}
                            </span>
                          </div>
                        )}
                        <span className="text-[10px] text-green-500 font-mono flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          Done
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Empty state when nothing is happening */}
          {activeTasks.length === 0 &&
            completedTasks.length === 0 &&
            taskDefs.length === 0 &&
            !lastBatch && (
              <div className="text-center py-16">
                <div className="w-20 h-20 rounded-2xl bg-amber-500/10 flex items-center justify-center mx-auto mb-4">
                  <Zap className="w-10 h-10 text-amber-400/40" />
                </div>
                <h3 className="text-lg font-medium mb-2">
                  Ready to orchestrate
                </h3>
                <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">
                  Create multiple tasks, assign each to a different agent, and
                  launch them all in parallel. Monitor progress in real-time.
                </p>
                <div className="flex items-center gap-3 justify-center">
                  <Button onClick={addTask} className="gap-1.5">
                    <Plus className="w-4 h-4" />
                    Add Task
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowTemplates(true)}
                    className="gap-1.5"
                  >
                    <Sparkles className="w-4 h-4" />
                    Browse Templates
                  </Button>
                </div>
              </div>
            )}
        </div>
      </ScrollArea>

      {/* Save as Mission Modal */}
      <Dialog open={showSaveMissionModal} onOpenChange={setShowSaveMissionModal}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Save as Mission</DialogTitle>
            <DialogDescription>
              Save this orchestrated queue as a repeatable mission blueprint.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4 mt-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Mission Name</label>
              <input
                className="w-full px-3 py-2 rounded-md border border-input bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                value={newMissionName}
                onChange={(e) => setNewMissionName(e.target.value)}
                placeholder="e.g. Lead Gen Pipeline"
                maxLength={200}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <textarea
                className="w-full px-3 py-2 rounded-md border border-input bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 min-h-[60px] resize-y"
                value={newMissionDesc}
                onChange={(e) => setNewMissionDesc(e.target.value)}
                placeholder="What does this blueprint do?"
                maxLength={2000}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSaveMissionModal(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={saveQueueAsMission}
              disabled={!newMissionName.trim() || savingMission}
            >
              {savingMission ? "Saving..." : "Save Mission"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
