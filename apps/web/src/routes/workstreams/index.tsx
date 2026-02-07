"use client";

import { useState, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  GitBranch,
  Plus,
  Search,
  LayoutGrid,
  Network,
  Workflow,
  Filter,
} from "lucide-react";
import { useWorkstreams, type WorkstreamStatus } from "@/hooks/queries/useWorkstreams";
import { useWorkQueueItems } from "@/hooks/queries/useWorkQueue";
import { useAgents } from "@/hooks/queries/useAgents";
import { WorkstreamCard } from "@/components/domain/workstreams/WorkstreamCard";
import { CreateWorkstreamModal } from "@/components/domain/workstreams/CreateWorkstreamModal";
import { WorkstreamDAG } from "@/components/domain/workstreams/WorkstreamDAG";
import { TaskDetailPanel } from "@/components/domain/workstreams/TaskDetailPanel";
import { WorkflowVisualization } from "@/components/domain/workflow";
import type { Task } from "@/hooks/queries/useWorkstreams";

import { RouteErrorFallback } from "@/components/composed";
export const Route = createFileRoute("/workstreams/")({
  component: WorkstreamsPage,
  errorComponent: RouteErrorFallback,
});

type ViewMode = "list" | "dag" | "workflow";
type StatusFilter = "all" | WorkstreamStatus;

const statusFilters: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
];

function WorkstreamsPage() {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedWorkstreamId, setSelectedWorkstreamId] = useState<string | null>(null);

  const { data: workstreams = [], isLoading, error } = useWorkstreams();
  const { data: queueItems } = useWorkQueueItems();
  const { data: agents = [] } = useAgents();

  // Filter workstreams
  const filteredWorkstreams = useMemo(() => {
    return workstreams.filter((ws) => {
      // Status filter
      if (statusFilter !== "all" && ws.status !== statusFilter) {
        return false;
      }

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return (
          ws.name.toLowerCase().includes(query) ||
          ws.description?.toLowerCase().includes(query) ||
          ws.tags?.some((tag) => tag.toLowerCase().includes(query))
        );
      }

      return true;
    });
  }, [workstreams, statusFilter, searchQuery]);

  // All tasks for DAG view
  const allTasks = useMemo(() => {
    return filteredWorkstreams.flatMap((ws) => ws.tasks);
  }, [filteredWorkstreams]);

  // Get owner agent for a workstream
  const getOwner = (ownerId?: string) => {
    if (!ownerId) {return null;}
    return agents.find((a) => a.id === ownerId);
  };

  const handleViewDetails = (workstreamId: string) => {
    navigate({ to: "/workstreams/$workstreamId", params: { workstreamId } });
  };

  const handleOpenDAG = (workstreamId: string) => {
    navigate({ to: "/workstreams/$workstreamId", params: { workstreamId } });
  };

  const handleTaskClick = (task: Task) => {
    setSelectedTask(task);
    setSelectedWorkstreamId(task.workstreamId);
  };

  const handleCreateSuccess = (workstreamId: string) => {
    navigate({ to: "/workstreams/$workstreamId", params: { workstreamId } });
  };

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-destructive">Error loading workstreams</h2>
          <p className="text-muted-foreground mt-2">{error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="sticky top-0 z-10 -mx-4 -mt-6 sm:-mx-6 lg:-mx-8 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-6 py-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            {/* Title and count */}
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                <GitBranch className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">Workstreams</h1>
                <p className="text-sm text-muted-foreground">
                  {filteredWorkstreams.length} workstream{filteredWorkstreams.length !== 1 ? "s" : ""}
                </p>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3">
              {/* Search */}
              <div className="relative flex-1 md:w-64">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search workstreams..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>

              {/* View toggle */}
              <div className="flex rounded-lg border border-border p-1">
                <Button
                  size="sm"
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  className="h-7 px-2"
                  onClick={() => setViewMode("list")}
                >
                  <LayoutGrid className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant={viewMode === "dag" ? "secondary" : "ghost"}
                  className="h-7 px-2"
                  onClick={() => setViewMode("dag")}
                >
                  <Network className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant={viewMode === "workflow" ? "secondary" : "ghost"}
                  className="h-7 px-2"
                  onClick={() => setViewMode("workflow")}
                >
                  <Workflow className="h-4 w-4" />
                </Button>
              </div>

              {/* Create button */}
              <Button onClick={() => setIsCreateModalOpen(true)} className="gap-2">
                <Plus className="h-4 w-4" />
                <span className="hidden md:inline">Create</span>
              </Button>
            </div>
          </div>

          {/* Status filters */}
          <div className="mt-4 flex items-center gap-2 overflow-x-auto pb-2">
            <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
            {statusFilters.map((filter) => {
              const count =
                filter.value === "all"
                  ? workstreams.length
                  : workstreams.filter((ws) => ws.status === filter.value).length;

              return (
                <Button
                  key={filter.value}
                  size="sm"
                  variant={statusFilter === filter.value ? "default" : "outline"}
                  className="h-7 gap-1.5 shrink-0"
                  onClick={() => setStatusFilter(filter.value)}
                >
                  {filter.label}
                  <Badge
                    variant="secondary"
                    className={cn(
                      "h-5 min-w-[20px] px-1.5 text-xs",
                      statusFilter === filter.value && "bg-primary-foreground/20"
                    )}
                  >
                    {count}
                  </Badge>
                </Button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto max-w-7xl px-6 py-6">
        {isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-72 rounded-2xl" />
            ))}
          </div>
        ) : filteredWorkstreams.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-16 text-center"
          >
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <GitBranch className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="mb-2 text-xl font-semibold">No workstreams found</h2>
            <p className="mb-6 max-w-md text-muted-foreground">
              {searchQuery || statusFilter !== "all"
                ? "Try adjusting your filters or search query"
                : "Create your first workstream to start organizing tasks"}
            </p>
            {!searchQuery && statusFilter === "all" && (
              <Button onClick={() => setIsCreateModalOpen(true)} className="gap-2">
                <Plus className="h-4 w-4" />
                Create Workstream
              </Button>
            )}
          </motion.div>
        ) : viewMode === "list" ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="grid gap-6 md:grid-cols-2 lg:grid-cols-3"
          >
            <AnimatePresence mode="popLayout">
              {filteredWorkstreams.map((workstream) => (
                <WorkstreamCard
                  key={workstream.id}
                  workstream={workstream}
                  owner={getOwner(workstream.ownerId)}
                  onViewDetails={() => handleViewDetails(workstream.id)}
                  onOpenDAG={() => handleOpenDAG(workstream.id)}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        ) : viewMode === "dag" ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-[calc(100vh-240px)] min-h-[500px] rounded-xl border border-border bg-card overflow-hidden"
          >
            <WorkstreamDAG
              tasks={allTasks}
              agents={agents}
              queueItems={queueItems}
              onTaskClick={handleTaskClick}
              onAddTask={() => setIsCreateModalOpen(true)}
            />
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-xl border border-border bg-card p-4"
          >
            <WorkflowVisualization />
          </motion.div>
        )}
      </div>

      {/* Create Modal */}
      <CreateWorkstreamModal
        open={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={handleCreateSuccess}
      />

      {/* Task Detail Panel */}
      <TaskDetailPanel
        open={!!selectedTask}
        onClose={() => {
          setSelectedTask(null);
          setSelectedWorkstreamId(null);
        }}
        task={selectedTask}
        workstreamId={selectedWorkstreamId || ""}
        allTasks={allTasks}
        onTaskClick={(taskId) => {
          const task = allTasks.find((t) => t.id === taskId);
          if (task) {
            setSelectedTask(task);
            setSelectedWorkstreamId(task.workstreamId);
          }
        }}
      />
    </>
  );
}
