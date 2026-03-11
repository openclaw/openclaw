import { AlertCircle, FolderKanban } from "lucide-react";
import { useMemo } from "react";
import { ProjectSection } from "@/components/projects/ProjectSection";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePanels } from "@/contexts/PanelContext";
import { useTasks } from "@/hooks/useTasks";
import { perspectives } from "@/lib/sla-perspectives";
import type { Task, Project, ProjectSLA } from "@/lib/types";

const BUSINESS_ID = "vividwalls";

function deriveSLA(tasks: Task[]): ProjectSLA {
  const hasHighPriority = tasks.some((t) => t.priority === "high");
  const hasShortDuration = tasks.some((t) => {
    if (!t.estimated_duration) return false;
    const hours = parseFloat(t.estimated_duration);
    return !isNaN(hours) && hours <= 2;
  });

  if (hasHighPriority || hasShortDuration) return "critical";

  const allLow = tasks.every((t) => t.priority === "low");
  if (allLow) return "relaxed";

  return "standard";
}

export function ProjectsPage() {
  const { data: tasks = [], isLoading, error } = useTasks(BUSINESS_ID);
  const { openDetailPanel } = usePanels();

  // Group tasks by plan_name into projects
  const projects = useMemo(() => {
    const grouped = new Map<string, Task[]>();
    for (const task of tasks) {
      const key = task.plan_id;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(task);
    }

    const result: { project: Project; tasks: Task[] }[] = [];
    for (const [planId, planTasks] of grouped) {
      const name = planTasks[0]?.plan_name || "General";
      const completedCount = planTasks.filter((t) => t.status === "done").length;
      result.push({
        project: {
          id: planId,
          name,
          sla: deriveSLA(planTasks),
          taskCount: planTasks.length,
          completedCount,
        },
        tasks: planTasks,
      });
    }

    // Sort: critical first, then standard, then relaxed
    const slaOrder: Record<ProjectSLA, number> = { critical: 0, standard: 1, relaxed: 2 };
    result.sort((a, b) => slaOrder[a.project.sla] - slaOrder[b.project.sla]);

    return result;
  }, [tasks]);

  function handleTaskClick(task: Task) {
    openDetailPanel("task", task.id, task);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-lg"
          style={{
            backgroundColor: `color-mix(in srgb, var(--accent-orange) 15%, transparent)`,
          }}
        >
          <FolderKanban className="w-5 h-5 text-[var(--accent-orange)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Projects</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {isLoading
              ? "Loading projects..."
              : `${projects.length} projects, ${tasks.length} total tasks`}
          </p>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[color-mix(in_srgb,var(--accent-red)_10%,var(--bg-card))] border border-[var(--accent-red)]/20">
          <AlertCircle className="w-5 h-5 text-[var(--accent-red)] shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Failed to load projects
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Unable to fetch project data from the API. Please try again later.
            </p>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {isLoading && (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-14 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] animate-pulse"
            />
          ))}
        </div>
      )}

      {/* SLA Perspective Tabs + Project sections */}
      {!isLoading && projects.length > 0 && (
        <Tabs defaultValue="status" className="w-full">
          <div className="flex justify-center mb-4">
            <TabsList className="bg-[var(--bg-secondary)]">
              {perspectives.map((p) => (
                <TabsTrigger
                  key={p.id}
                  value={p.id}
                  className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
                >
                  {p.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {perspectives.map((p) => (
            <TabsContent key={p.id} value={p.id}>
              <div className="space-y-4">
                {projects.map((entry, index) => (
                  <ProjectSection
                    key={entry.project.id}
                    project={entry.project}
                    tasks={entry.tasks}
                    defaultOpen={index === 0}
                    onTaskClick={handleTaskClick}
                    columns={p.columns}
                  />
                ))}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      )}

      {/* Empty state */}
      {!isLoading && !error && projects.length === 0 && (
        <div className="text-center py-12">
          <FolderKanban className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <p className="text-sm text-[var(--text-secondary)]">No projects found.</p>
        </div>
      )}
    </div>
  );
}
