import { AlertCircle } from "lucide-react";
import { AgentStatusGrid } from "@/components/dashboard/AgentStatusGrid";
import { BdiStatusPanel } from "@/components/dashboard/BdiStatusPanel";
import { RecentActivity } from "@/components/dashboard/RecentActivity";
import { StatusCards } from "@/components/dashboard/StatusCards";
import { useAgents } from "@/hooks/useAgents";
import { useCronJobs } from "@/hooks/useCronJobs";
import { useStatus } from "@/hooks/useStatus";
import { useTasks } from "@/hooks/useTasks";
import type { SystemStatus, Task, AgentListResponse, CronJob } from "@/lib/types";

const BUSINESS_ID = "vividwalls";

export function OverviewPage() {
  const { data: statusRaw, isLoading: statusLoading, error: statusError } = useStatus();
  const { data: agentsRaw, isLoading: agentsLoading, error: agentsError } = useAgents(BUSINESS_ID);
  const { data: tasksRaw, isLoading: tasksLoading } = useTasks(BUSINESS_ID);
  const { data: cronJobs } = useCronJobs(BUSINESS_ID);

  const status = statusRaw as SystemStatus | undefined;
  const agentsResponse = agentsRaw as AgentListResponse | undefined;
  const agents = agentsResponse?.agents;
  const tasks = tasksRaw as Task[] | undefined;

  const hasError = statusError || agentsError;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Overview</h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          MABOS Multi-Agent Business Operating System
        </p>
      </div>

      {/* Error banner */}
      {hasError && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[color-mix(in_srgb,var(--accent-red)_10%,var(--bg-card))] border border-[var(--accent-red)]/20">
          <AlertCircle className="w-5 h-5 text-[var(--accent-red)] shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Connection Issue</p>
            <p className="text-xs text-[var(--text-secondary)]">
              Unable to reach the MABOS API. Some data may be unavailable.
            </p>
          </div>
        </div>
      )}

      {/* Status Cards */}
      <StatusCards status={status} tasks={tasks} isLoading={statusLoading || tasksLoading} />

      {/* BDI Status Panel */}
      <BdiStatusPanel
        status={status}
        agents={agents}
        cronJobs={cronJobs as CronJob[] | undefined}
      />

      {/* Agent Status Grid */}
      <AgentStatusGrid agents={agents} isLoading={agentsLoading} />

      {/* Recent Activity */}
      <RecentActivity />
    </div>
  );
}
