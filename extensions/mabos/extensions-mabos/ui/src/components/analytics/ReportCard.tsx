import { Play, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import type { AnalyticsReport } from "@/lib/types";

interface Props {
  report: AnalyticsReport;
  onRun: (id: string) => void;
  isRunning: boolean;
  onClick?: (report: AnalyticsReport) => void;
}

export function ReportCard({ report, onRun, isRunning, onClick }: Props) {
  return (
    <Card
      className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none hover:border-[var(--accent-blue)] transition-colors cursor-pointer"
      onClick={() => onClick?.(report)}
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-medium text-[var(--text-primary)] line-clamp-2">
            {report.name}
          </h3>
          <StatusBadge status={report.type ?? "custom"} />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[10px] text-[var(--text-muted)]">
            {report.last_run
              ? `Last run: ${new Date(report.last_run).toLocaleDateString()}`
              : "Never run"}
          </span>
          <button
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors"
            style={{
              backgroundColor: "color-mix(in srgb, var(--accent-blue) 15%, transparent)",
              color: "var(--accent-blue)",
            }}
            onClick={(e) => {
              e.stopPropagation();
              onRun(report.id);
            }}
            disabled={isRunning}
          >
            {isRunning ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Play className="w-3 h-3" />
            )}
            Run
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
