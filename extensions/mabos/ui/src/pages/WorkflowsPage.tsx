import { Link } from "@tanstack/react-router";
import { GitBranch, AlertCircle } from "lucide-react";
import { useState, useMemo } from "react";
import { WorkflowSteps } from "@/components/goals/WorkflowSteps";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePanels } from "@/contexts/PanelContext";
import { useGoalModel } from "@/hooks/useGoalModel";
import type { Workflow, WorkflowStatus } from "@/lib/types";

const BUSINESS_ID = "vividwalls";

const statusOptions: WorkflowStatus[] = ["active", "pending", "paused", "completed"];

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

export function WorkflowsPage() {
  const { data: goalModel, isLoading, error } = useGoalModel(BUSINESS_ID);
  const [statusFilter, setStatusFilter] = useState<WorkflowStatus | "all">("all");
  const { openDetailPanel } = usePanels();

  // Extract all workflows from goals
  const workflows: (Workflow & { goalName: string })[] = useMemo(() => {
    if (!goalModel) return [];
    const rawGoals = goalModel.goals ?? [];
    const result: (Workflow & { goalName: string })[] = [];
    for (const g of rawGoals) {
      const goalName = g.text ?? g.name ?? g.id ?? "";
      for (const w of g.workflows ?? []) {
        result.push({ ...w, goalName });
      }
    }
    return result;
  }, [goalModel]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return workflows;
    return workflows.filter((w) => w.status === statusFilter);
  }, [workflows, statusFilter]);

  return (
    <div className="space-y-6">
      {/* Header */}
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

      {/* Filters */}
      {!isLoading && workflows.length > 0 && (
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
        {isLoading
          ? Array.from({ length: 3 }).map((_, i) => <WorkflowSkeleton key={i} />)
          : filtered.map((workflow) => (
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
                    </div>
                  </div>
                  <WorkflowSteps workflow={workflow} />
                </CardContent>
              </Card>
            ))}
      </div>

      {/* Empty state */}
      {!isLoading && !error && filtered.length === 0 && (
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
    </div>
  );
}
