import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import type { MarketingKpi } from "@/lib/types";

type Props = {
  kpis: MarketingKpi[] | undefined;
  isLoading: boolean;
};

function KpiCard({ kpi }: { kpi: MarketingKpi }) {
  const progress = kpi.target > 0 ? Math.min((kpi.current / kpi.target) * 100, 100) : 0;
  const color =
    progress >= 80
      ? "var(--accent-green)"
      : progress >= 50
        ? "var(--accent-orange)"
        : "var(--accent-red)";

  return (
    <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[var(--text-primary)]">{kpi.name}</span>
          <StatusBadge status={kpi.status} />
        </div>
        <div className="flex items-end justify-between">
          <span className="text-2xl font-bold text-[var(--text-primary)]">
            {kpi.current.toLocaleString()}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            / {kpi.target.toLocaleString()} {kpi.unit || ""}
          </span>
        </div>
        {/* Progress bar */}
        <div className="h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${progress}%`, backgroundColor: color }}
          />
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {progress.toFixed(0)}% of target {kpi.period ? `(${kpi.period})` : ""}
        </p>
      </CardContent>
    </Card>
  );
}

export function KpiProgressCards({ kpis, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
            <CardContent className="pt-4 space-y-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-2 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!kpis || kpis.length === 0) {
    return (
      <div className="text-center py-6 text-sm text-[var(--text-muted)]">
        No marketing KPIs configured
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {kpis.slice(0, 4).map((kpi) => (
        <KpiCard key={kpi.id} kpi={kpi} />
      ))}
    </div>
  );
}
