import { FileText, LayoutDashboard, Clock, Camera } from "lucide-react";
import { StatCard, StatCardRow, StatCardSkeleton } from "@/components/ui/stat-card";
import type { AnalyticsReport, AnalyticsDashboard } from "@/lib/types";

interface Props {
  reports?: AnalyticsReport[];
  dashboards?: AnalyticsDashboard[];
  isLoading: boolean;
}

export function AnalyticsStatsRow({ reports, dashboards, isLoading }: Props) {
  if (isLoading) {
    return (
      <StatCardRow>
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </StatCardRow>
    );
  }

  const totalReports = reports?.length ?? 0;
  const activeDashboards = dashboards?.length ?? 0;

  const lastRun = reports
    ?.filter((r) => r.last_run)
    .sort((a, b) => new Date(b.last_run!).getTime() - new Date(a.last_run!).getTime())[0];

  const lastRunLabel = lastRun?.last_run
    ? new Date(lastRun.last_run).toLocaleDateString()
    : "Never";

  const totalWidgets = dashboards?.reduce((sum, d) => sum + (d.widgets?.length ?? 0), 0) ?? 0;

  return (
    <StatCardRow>
      <StatCard
        label="Total Reports"
        value={totalReports}
        icon={FileText}
        color="var(--accent-blue)"
      />
      <StatCard
        label="Active Dashboards"
        value={activeDashboards}
        icon={LayoutDashboard}
        color="var(--accent-purple)"
      />
      <StatCard label="Last Run" value={lastRunLabel} icon={Clock} color="var(--accent-green)" />
      <StatCard
        label="Total Widgets"
        value={totalWidgets}
        icon={Camera}
        color="var(--accent-orange)"
      />
    </StatCardRow>
  );
}
