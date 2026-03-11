import type { AnalyticsReport } from "@/lib/types";
import { ReportCard } from "./ReportCard";

interface Props {
  reports: AnalyticsReport[];
  onRun: (id: string) => void;
  runningId: string | null;
  onReportClick?: (report: AnalyticsReport) => void;
}

export function ReportGrid({ reports, onRun, runningId, onReportClick }: Props) {
  if (reports.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-[var(--text-muted)]">
        No reports found. Create reports through the Analytics agent in the chat panel.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {reports.map((report) => (
        <ReportCard
          key={report.id}
          report={report}
          onRun={onRun}
          isRunning={runningId === report.id}
          onClick={onReportClick}
        />
      ))}
    </div>
  );
}
