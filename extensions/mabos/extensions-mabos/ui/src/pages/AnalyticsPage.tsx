import { LineChart } from "lucide-react";
import { useState } from "react";
import { AnalyticsStatsRow } from "@/components/analytics/AnalyticsStatsRow";
import { DashboardList } from "@/components/analytics/DashboardList";
import { ReportGrid } from "@/components/analytics/ReportGrid";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useReports, useDashboards, useRunReport, useReportSnapshots } from "@/hooks/useAnalytics";
import type { AnalyticsReport } from "@/lib/types";

const ACCENT = "var(--accent-blue)";

type Tab = "reports" | "dashboards";
const TABS: { key: Tab; label: string }[] = [
  { key: "reports", label: "Reports" },
  { key: "dashboards", label: "Dashboards" },
];

export function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>("reports");
  const [typeFilter, setTypeFilter] = useState("");
  const [selectedReport, setSelectedReport] = useState<AnalyticsReport | null>(null);

  const { data: reportsData, isLoading: reportsLoading } = useReports(
    typeFilter ? { type: typeFilter } : undefined,
  );
  const { data: dashboardsData, isLoading: dashboardsLoading } = useDashboards();
  const runReport = useRunReport();
  const { data: snapshotsData } = useReportSnapshots(selectedReport?.id ?? "");

  const reports = (reportsData as any)?.reports ?? [];
  const dashboards = (dashboardsData as any)?.dashboards ?? [];
  const snapshots = (snapshotsData as any)?.snapshots ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{
            backgroundColor: `color-mix(in srgb, ${ACCENT} 15%, var(--bg-card))`,
          }}
        >
          <LineChart className="w-5 h-5" style={{ color: ACCENT }} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Analytics</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-0.5">
            KPI tracking, reports, and business intelligence dashboards
          </p>
        </div>
      </div>

      {/* Stats */}
      <AnalyticsStatsRow
        reports={reports}
        dashboards={dashboards}
        isLoading={reportsLoading || dashboardsLoading}
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border-mabos)]">
        {TABS.map((t) => (
          <button
            key={t.key}
            className="px-4 py-2 text-sm font-medium transition-colors relative"
            style={{
              color: tab === t.key ? ACCENT : "var(--text-muted)",
            }}
            onClick={() => {
              setTab(t.key);
              setSelectedReport(null);
            }}
          >
            {t.label}
            {tab === t.key && (
              <div
                className="absolute bottom-0 left-0 right-0 h-0.5"
                style={{ backgroundColor: ACCENT }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Reports tab */}
      {tab === "reports" && (
        <div className="space-y-4">
          {/* Type filter */}
          <div className="flex gap-2">
            <select
              className="px-3 py-1.5 rounded-md border border-[var(--border-mabos)] bg-[var(--bg-card)] text-sm text-[var(--text-primary)]"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="">All Types</option>
              <option value="kpi">KPI</option>
              <option value="financial">Financial</option>
              <option value="operational">Operational</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          <ReportGrid
            reports={reports}
            onRun={(id) => runReport.mutate(id)}
            runningId={runReport.isPending ? (runReport.variables as string) : null}
            onReportClick={setSelectedReport}
          />

          {/* Snapshot detail */}
          {selectedReport && (
            <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-[var(--text-primary)]">
                    Snapshots: {selectedReport.name}
                  </h3>
                  <button
                    className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    onClick={() => setSelectedReport(null)}
                  >
                    Close
                  </button>
                </div>
              </CardHeader>
              <CardContent>
                {snapshots.length === 0 ? (
                  <p className="text-sm text-[var(--text-muted)] py-4 text-center">
                    No snapshots yet. Run the report to generate one.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {snapshots.map((snap: any) => (
                      <div
                        key={snap.id}
                        className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)]"
                      >
                        <div>
                          <p className="text-sm text-[var(--text-primary)]">
                            Snapshot {new Date(snap.created_at).toLocaleString()}
                          </p>
                          <p className="text-[10px] text-[var(--text-muted)]">
                            {snap.row_count ?? 0} rows
                          </p>
                        </div>
                        <span className="text-xs text-[var(--text-muted)]">
                          {snap.format ?? "json"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Dashboards tab */}
      {tab === "dashboards" && (
        <DashboardList dashboards={dashboards} isLoading={dashboardsLoading} />
      )}
    </div>
  );
}
