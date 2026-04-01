import { Link, useNavigate } from "@tanstack/react-router";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  type Node,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import {
  GitBranch,
  AlertCircle,
  LayoutGrid,
  Network,
  Clock,
  Plus,
  Pencil,
  Timer,
} from "lucide-react";
import { useState, useMemo, useCallback } from "react";
import { CronBadge } from "@/components/cron/CronBadge";
import "@xyflow/react/dist/style.css";
import { WorkflowSteps } from "@/components/goals/WorkflowSteps";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WorkflowEdge } from "@/components/workflows/WorkflowEdge";
import { WorkflowGoalNode } from "@/components/workflows/WorkflowGoalNode";
import { WorkflowStepNode } from "@/components/workflows/WorkflowStepNode";
import { useActiveBusinessId } from "@/contexts/BusinessContext";
import { usePanels } from "@/contexts/PanelContext";
import { useCronJobs, useToggleCronJob } from "@/hooks/useCronJobs";
import { useGoalModel } from "@/hooks/useGoalModel";
import { api } from "@/lib/api";
import { cronToHuman, nextRunFromNow } from "@/lib/cron-utils";
import type { CronJob, EntityType, Workflow, WorkflowStatus } from "@/lib/types";
import { workflowsToFlowGraph } from "@/lib/workflow-layout";
import type { WorkflowGoalNodeData, WorkflowStepNodeData } from "@/lib/workflow-layout";

const statusOptions: WorkflowStatus[] = ["active", "pending", "paused", "completed"];

type ViewMode = "graph" | "list" | "cron";

const nodeTypes: NodeTypes = {
  workflowGoalNode: WorkflowGoalNode,
  workflowStepNode: WorkflowStepNode,
};

const edgeTypes: EdgeTypes = {
  workflowEdge: WorkflowEdge,
};

function WorkflowSkeleton() {
  return (
    <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4">
      <CardContent className="space-y-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      </CardContent>
    </Card>
  );
}

function WorkflowListView({
  workflows,
  statusFilter,
  setStatusFilter,
  openDetailPanel,
}: {
  workflows: (Workflow & { goalName: string })[];
  statusFilter: WorkflowStatus | "all";
  setStatusFilter: (v: WorkflowStatus | "all") => void;
  openDetailPanel: (type: EntityType, id: string, data: unknown) => void;
}) {
  const filtered = useMemo(() => {
    if (statusFilter === "all") return workflows;
    return workflows.filter((w) => w.status === statusFilter);
  }, [workflows, statusFilter]);

  return (
    <>
      {/* Filters */}
      {workflows.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as WorkflowStatus | "all")}
            className="px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
          >
            <option value="all">All Statuses</option>
            {statusOptions.map((s) => (
              <option key={s} value={s} className="capitalize">
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Workflows list */}
      <div className="space-y-4">
        {filtered.map((workflow) => (
          <Card
            key={workflow.id}
            className="bg-[var(--bg-card)] border-[var(--border-mabos)] cursor-pointer hover:border-[var(--border-hover)] transition-colors"
            onClick={() => openDetailPanel("workflow", workflow.id, workflow)}
          >
            <CardContent className="py-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="text-[10px] border-[var(--accent-purple)]/30 text-[var(--accent-purple)]"
                  >
                    {workflow.goalName}
                  </Badge>
                  {workflow.schedule && (
                    <CronBadge schedule={workflow.schedule} variant="compact" />
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    to="/workflows/$workflowId/edit"
                    params={{ workflowId: workflow.id }}
                    className="text-[10px] text-[var(--accent-blue)] hover:underline flex items-center gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Pencil className="w-2.5 h-2.5" />
                    Edit
                  </Link>
                  {workflow.schedule && (
                    <span className="text-[10px] text-[var(--text-muted)]">
                      Next:{" "}
                      {nextRunFromNow(workflow.schedule.cronExpression, workflow.schedule.timezone)}
                    </span>
                  )}
                  {(() => {
                    const scheduledCount = workflow.steps.filter(
                      (s) => s.schedule?.cronExpression,
                    ).length;
                    return scheduledCount > 0 ? (
                      <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-0.5">
                        <Clock className="w-2.5 h-2.5" />
                        {scheduledCount} step{scheduledCount !== 1 ? "s" : ""}
                      </span>
                    ) : null;
                  })()}
                </div>
              </div>
              <WorkflowSteps workflow={workflow} />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Empty state for list */}
      {filtered.length === 0 && (
        <div className="text-center py-12">
          <GitBranch className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <p className="text-sm text-[var(--text-secondary)]">
            {workflows.length > 0
              ? "No workflows match the current filter."
              : "No workflows defined yet."}
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-2">
            Workflows are created as part of{" "}
            <Link to="/goals" className="text-[var(--accent-purple)] hover:underline">
              Business Goals
            </Link>
            .
          </p>
        </div>
      )}
    </>
  );
}

function NewWorkflowButton() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await api.createWorkflow({
        name: "New Workflow",
        status: "pending",
      });
      if (result.id) {
        navigate({ to: "/workflows/$workflowId/edit", params: { workflowId: result.id } });
      }
    } catch {
      setCreating(false);
    }
  };

  return (
    <button
      onClick={handleCreate}
      disabled={creating}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
        bg-[var(--accent-blue)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
    >
      <Plus className="w-3.5 h-3.5" />
      {creating ? "Creating..." : "New Workflow"}
    </button>
  );
}

export function CronJobsView() {
  const businessId = useActiveBusinessId();
  const { data: cronJobs, isLoading } = useCronJobs(businessId);
  const toggleMutation = useToggleCronJob(businessId);
  const [sourceFilter, setSourceFilter] = useState<"all" | "local" | "gateway">("all");

  const filtered = useMemo(() => {
    if (!cronJobs) return [];
    if (sourceFilter === "all") return cronJobs;
    return cronJobs.filter((j) => j.source === sourceFilter);
  }, [cronJobs, sourceFilter]);

  const localCount = cronJobs?.filter((j) => j.source === "local").length ?? 0;
  const gatewayCount = cronJobs?.filter((j) => j.source === "gateway").length ?? 0;

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  const statusColor = (job: CronJob) => {
    if (job.status === "error" || (job.consecutiveErrors && job.consecutiveErrors > 0))
      return "var(--accent-red)";
    if (!job.enabled || job.status === "paused") return "var(--text-muted)";
    return "var(--accent-green)";
  };

  return (
    <div className="space-y-4">
      {/* Source filter */}
      <div className="flex items-center gap-3 text-xs">
        <button
          onClick={() => setSourceFilter("all")}
          className={`px-2.5 py-1 rounded-md transition-colors ${sourceFilter === "all" ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}
        >
          All ({cronJobs?.length ?? 0})
        </button>
        <button
          onClick={() => setSourceFilter("local")}
          className={`px-2.5 py-1 rounded-md transition-colors ${sourceFilter === "local" ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}
        >
          MABOS ({localCount})
        </button>
        <button
          onClick={() => setSourceFilter("gateway")}
          className={`px-2.5 py-1 rounded-md transition-colors ${sourceFilter === "gateway" ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}
        >
          Gateway ({gatewayCount})
        </button>
      </div>

      {/* Jobs list */}
      <div className="space-y-2">
        {filtered.map((job) => (
          <div
            key={job.id}
            className="flex items-center gap-3 px-4 py-3 rounded-lg border bg-[var(--bg-card)] border-[var(--border-mabos)] hover:border-[var(--border-hover)] transition-colors"
          >
            {/* Status dot */}
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: statusColor(job) }}
            />

            {/* Name + schedule */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-[var(--text-primary)] truncate font-medium">
                  {job.name}
                </span>
                {job.source === "gateway" && (
                  <Badge
                    variant="outline"
                    className="text-[9px] border-[var(--accent-orange)]/30 text-[var(--accent-orange)]"
                  >
                    gateway
                  </Badge>
                )}
                {job.agentId && (
                  <span className="text-[10px] text-[var(--accent-purple)] bg-[color-mix(in_srgb,var(--accent-purple)_8%,transparent)] px-1.5 py-0.5 rounded font-mono shrink-0">
                    {job.agentId}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-0.5 text-[10px] text-[var(--text-muted)]">
                <span className="flex items-center gap-1">
                  <Clock className="w-2.5 h-2.5" />
                  {cronToHuman(job.schedule)}
                </span>
                {job.action && <span className="font-mono">{job.action}</span>}
                {job.lastStatus && (
                  <span
                    style={{
                      color: job.lastStatus === "error" ? "var(--accent-red)" : "var(--text-muted)",
                    }}
                  >
                    last: {job.lastStatus}
                  </span>
                )}
                {job.consecutiveErrors != null && job.consecutiveErrors > 0 && (
                  <span style={{ color: "var(--accent-red)" }}>
                    {job.consecutiveErrors} error{job.consecutiveErrors !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </div>

            {/* Next run */}
            <div className="text-right shrink-0">
              {job.nextRun && (
                <span className="text-[10px] text-[var(--text-muted)]">
                  Next: {nextRunFromNow(job.schedule)}
                </span>
              )}
              {job.lastRun && (
                <div className="text-[10px] text-[var(--text-muted)]">
                  Last: {new Date(job.lastRun).toLocaleDateString()}
                </div>
              )}
            </div>

            {/* Toggle */}
            <button
              onClick={() => toggleMutation.mutate({ jobId: job.id, enabled: !job.enabled })}
              className="shrink-0 px-2 py-1 text-[10px] rounded border transition-colors"
              style={{
                borderColor: job.enabled
                  ? "color-mix(in srgb, var(--accent-green) 40%, transparent)"
                  : "color-mix(in srgb, var(--text-muted) 30%, transparent)",
                color: job.enabled ? "var(--accent-green)" : "var(--text-muted)",
              }}
            >
              {job.enabled ? "Enabled" : "Disabled"}
            </button>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12">
          <Timer className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <p className="text-sm text-[var(--text-secondary)]">No cron jobs found.</p>
        </div>
      )}
    </div>
  );
}

export function WorkflowsPage() {
  const businessId = useActiveBusinessId();
  const { data: goalModel, isLoading, error } = useGoalModel(businessId);
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const [statusFilter, setStatusFilter] = useState<WorkflowStatus | "all">("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [levelFilter, setLevelFilter] = useState("all");
  const { openDetailPanel } = usePanels();

  // Derive available agents from goal model
  const agents = useMemo(() => {
    if (!goalModel) return [];
    return (goalModel.actors ?? []).filter((a) => a.type === "agent");
  }, [goalModel]);

  // Extract all workflows for list view (with agent/level filters applied)
  const workflows: (Workflow & { goalName: string })[] = useMemo(() => {
    if (!goalModel) return [];
    let rawGoals = goalModel.goals ?? [];
    if (agentFilter && agentFilter !== "all") {
      rawGoals = rawGoals.filter(
        (g) => g.actor === agentFilter || g.actor?.endsWith(`-${agentFilter}`),
      );
    }
    if (levelFilter && levelFilter !== "all") {
      rawGoals = rawGoals.filter((g) => g.level === levelFilter);
    }
    const result: (Workflow & { goalName: string })[] = [];
    for (const g of rawGoals) {
      const goalName = g.text ?? g.name ?? g.id ?? "";
      for (const w of g.workflows ?? []) {
        result.push({ ...w, goalName });
      }
    }
    return result;
  }, [goalModel, agentFilter, levelFilter]);

  // Compute React Flow graph from goal model
  const { nodes, edges } = useMemo(() => {
    if (!goalModel) return { nodes: [], edges: [] };
    return workflowsToFlowGraph(goalModel, {
      agent: agentFilter,
      level: levelFilter,
    });
  }, [goalModel, agentFilter, levelFilter]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const d = node.data;
      if (node.type === "workflowGoalNode") {
        const goalData = d as unknown as WorkflowGoalNodeData;
        openDetailPanel("goal", goalData.goalId, goalData);
      } else if (node.type === "workflowStepNode") {
        const stepData = d as unknown as WorkflowStepNodeData;
        openDetailPanel("workflow", stepData.workflowId, stepData);
      }
    },
    [openDetailPanel],
  );

  const tabTriggerClass =
    "text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]";

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-3rem)]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-lg"
            style={{
              backgroundColor: `color-mix(in srgb, var(--accent-blue) 15%, transparent)`,
            }}
          >
            <GitBranch className="w-5 h-5 text-[var(--accent-blue)]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">Workflows</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              {workflows.length > 0
                ? `${workflows.length} workflow${workflows.length !== 1 ? "s" : ""} across business goals`
                : isLoading
                  ? "Loading workflows..."
                  : "BPMN process flows linked to business goals"}
            </p>
          </div>
        </div>

        {/* View toggle + New Workflow */}
        <div className="flex items-center gap-2">
          {!isLoading && (
            <div className="flex items-center rounded-lg border border-[var(--border-mabos)] overflow-hidden">
              <button
                onClick={() => setViewMode("graph")}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors"
                style={{
                  backgroundColor: viewMode === "graph" ? "var(--bg-secondary)" : "transparent",
                  color: viewMode === "graph" ? "var(--text-primary)" : "var(--text-muted)",
                }}
              >
                <Network className="w-3.5 h-3.5" />
                Graph
              </button>
              <button
                onClick={() => setViewMode("list")}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors"
                style={{
                  backgroundColor: viewMode === "list" ? "var(--bg-secondary)" : "transparent",
                  color: viewMode === "list" ? "var(--text-primary)" : "var(--text-muted)",
                }}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                List
              </button>
              <button
                onClick={() => setViewMode("cron")}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors"
                style={{
                  backgroundColor: viewMode === "cron" ? "var(--bg-secondary)" : "transparent",
                  color: viewMode === "cron" ? "var(--text-primary)" : "var(--text-muted)",
                }}
              >
                <Timer className="w-3.5 h-3.5" />
                Cron Jobs
              </button>
            </div>
          )}
          <NewWorkflowButton />
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[color-mix(in_srgb,var(--accent-red)_10%,var(--bg-card))] border border-[var(--accent-red)]/20">
          <AlertCircle className="w-5 h-5 text-[var(--accent-red)] shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Failed to load workflows
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Unable to fetch goal model from the API. Please try again later.
            </p>
          </div>
        </div>
      )}

      {/* Perspective Tabs */}
      {!isLoading && !error && (
        <div className="flex flex-col gap-2">
          {/* Agent row */}
          <Tabs value={agentFilter} onValueChange={setAgentFilter}>
            <TabsList className="bg-[var(--bg-secondary)]">
              <TabsTrigger value="all" className={tabTriggerClass}>
                All Agents
              </TabsTrigger>
              {agents.map((a) => (
                <TabsTrigger key={a.id} value={a.id} className={tabTriggerClass}>
                  {a.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* Goal Level row */}
          <Tabs value={levelFilter} onValueChange={setLevelFilter}>
            <TabsList className="bg-[var(--bg-secondary)]">
              <TabsTrigger value="all" className={tabTriggerClass}>
                All Levels
              </TabsTrigger>
              <TabsTrigger value="strategic" className={tabTriggerClass}>
                Strategic
              </TabsTrigger>
              <TabsTrigger value="tactical" className={tabTriggerClass}>
                Tactical
              </TabsTrigger>
              <TabsTrigger value="operational" className={tabTriggerClass}>
                Operational
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}

      {/* Legend (moved above canvas) */}
      {!isLoading && viewMode === "graph" && nodes.length > 0 && (
        <div className="flex items-center gap-6 text-xs text-[var(--text-muted)] flex-wrap">
          <span className="font-medium text-[var(--text-secondary)]">Goal levels:</span>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded border-2 border-[var(--accent-purple)]/40 bg-[color-mix(in_srgb,var(--accent-purple)_8%,transparent)]" />
            Strategic
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded border-2 border-[var(--accent-blue)]/40 bg-[color-mix(in_srgb,var(--accent-blue)_8%,transparent)]" />
            Tactical
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded border-2 border-[var(--accent-orange)]/40 bg-[color-mix(in_srgb,var(--accent-orange)_8%,transparent)]" />
            Operational
          </div>
          <span className="mx-1 text-[var(--border-mabos)]">|</span>
          <span className="font-medium text-[var(--text-secondary)]">Status:</span>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--accent-green)]" />
            Active
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--accent-blue)]" />
            Completed
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--accent-orange)]" />
            Paused
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--text-muted)]" />
            Pending
          </div>
        </div>
      )}

      {/* Loading state */}
      {isLoading &&
        (viewMode === "graph" ? (
          <div className="flex-1 min-h-0 rounded-lg bg-[var(--bg-card)] border border-[var(--border-mabos)] flex items-center justify-center">
            <div className="space-y-3 text-center">
              <Skeleton className="h-8 w-48 mx-auto" />
              <Skeleton className="h-4 w-32 mx-auto" />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <WorkflowSkeleton key={i} />
            ))}
          </div>
        ))}

      {/* Graph View — full height canvas */}
      {!isLoading && viewMode === "graph" && nodes.length > 0 && (
        <div
          className="flex-1 min-h-0 rounded-lg bg-[var(--bg-card)] border border-[var(--border-mabos)] relative"
          style={{
            // @ts-expect-error CSS custom properties
            "--xy-background-color": "var(--bg-card)",
            "--xy-edge-stroke-default": "var(--border-hover)",
            "--xy-controls-button-background-color": "var(--bg-secondary)",
            "--xy-controls-button-border-color": "var(--border-mabos)",
            "--xy-controls-button-color": "var(--text-secondary)",
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={onNodeClick}
            fitView
            minZoom={0.3}
            maxZoom={2}
            defaultEdgeOptions={{
              type: "smoothstep",
            }}
          >
            <Controls className="!bg-[var(--bg-secondary)] !border-[var(--border-mabos)] !shadow-none" />
            <Background
              variant={BackgroundVariant.Dots}
              color="var(--border-mabos)"
              gap={20}
              size={1}
            />
          </ReactFlow>
        </div>
      )}

      {/* List View */}
      {!isLoading && viewMode === "list" && (
        <WorkflowListView
          workflows={workflows}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          openDetailPanel={openDetailPanel}
        />
      )}

      {/* Cron Jobs View */}
      {viewMode === "cron" && <CronJobsView />}

      {/* Empty state for graph view */}
      {!isLoading && !error && viewMode === "graph" && nodes.length === 0 && (
        <div className="text-center py-12">
          <GitBranch className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <p className="text-sm text-[var(--text-secondary)]">No workflows defined yet.</p>
          <p className="text-xs text-[var(--text-muted)] mt-2">
            Workflows are created as part of{" "}
            <Link to="/goals" className="text-[var(--accent-purple)] hover:underline">
              Business Goals
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  );
}
