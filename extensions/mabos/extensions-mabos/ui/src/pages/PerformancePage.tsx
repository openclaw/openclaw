import { AlertCircle, BarChart3 } from "lucide-react";
import { useMetrics } from "@/hooks/useMetrics";
import { useAgents } from "@/hooks/useAgents";
import { MetricsCharts } from "@/components/performance/MetricsCharts";
import { AgentPerformance } from "@/components/performance/AgentPerformance";

type MetricsData = {
  revenue?: { date: string; value: number }[];
  taskCompletion?: { date: string; completed: number; total: number }[];
  agentEfficiency?: {
    agentId: string;
    tasksCompleted: number;
    avgDuration: number;
  }[];
  bdiCycles?: { date: string; cycles: number }[];
};

const BUSINESS_ID = "vividwalls";

export function PerformancePage() {
  const {
    data: metricsRaw,
    isLoading: metricsLoading,
    error: metricsError,
  } = useMetrics(BUSINESS_ID);
  const { isLoading: agentsLoading } = useAgents(BUSINESS_ID);

  const metrics = metricsRaw as MetricsData | undefined;

  const isLoading = metricsLoading || agentsLoading;
  const hasError = !!metricsError;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-lg"
          style={{
            backgroundColor: `color-mix(in srgb, var(--accent-purple) 15%, transparent)`,
          }}
        >
          <BarChart3 className="w-5 h-5 text-[var(--accent-purple)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">
            Performance
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {isLoading
              ? "Loading metrics..."
              : "Business metrics and agent analytics"}
          </p>
        </div>
      </div>

      {/* Error banner */}
      {hasError && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[color-mix(in_srgb,var(--accent-red)_10%,var(--bg-card))] border border-[var(--accent-red)]/20">
          <AlertCircle className="w-5 h-5 text-[var(--accent-red)] shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Failed to load metrics
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Unable to fetch performance data from the API. Showing placeholder
              data.
            </p>
          </div>
        </div>
      )}

      {/* Metrics Charts - 2x2 grid */}
      <MetricsCharts data={metrics} isLoading={isLoading} />

      {/* Agent Performance Table */}
      <AgentPerformance
        agentMetrics={metrics?.agentEfficiency}
        isLoading={isLoading}
      />
    </div>
  );
}
