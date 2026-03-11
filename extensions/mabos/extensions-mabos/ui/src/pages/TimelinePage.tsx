import { Calendar, AlertCircle } from "lucide-react";
import { useMemo } from "react";
import { GanttChart } from "@/components/timeline/GanttChart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useGoalModel } from "@/hooks/useGoalModel";
import {
  goalsToPhases,
  goalsToMilestones,
  calculateTotalWeeks,
  calculateCurrentWeek,
} from "@/lib/goal-transforms";

const BUSINESS_ID = "vividwalls";

// Legend items matching the design token colors used in the Gantt chart
const legendItems = [
  { label: "Strategy", color: "var(--accent-purple)" },
  { label: "Execution", color: "var(--accent-blue)" },
  { label: "Operations", color: "var(--accent-orange)" },
  { label: "Milestone", color: "var(--accent-green)", isMilestone: true },
  { label: "Current Week", color: "var(--accent-green)", isIndicator: true },
];

export function TimelinePage() {
  const { data: goalModel, isLoading, error } = useGoalModel(BUSINESS_ID);

  const phases = useMemo(() => {
    if (!goalModel) return [];
    const result = goalsToPhases(goalModel);
    return result.length > 0 ? result : [];
  }, [goalModel]);

  const milestones = useMemo(() => {
    if (!goalModel) return [];
    return goalsToMilestones(goalModel);
  }, [goalModel]);

  const totalWeeks = useMemo(() => calculateTotalWeeks(phases), [phases]);
  const currentWeek = useMemo(() => {
    const week = calculateCurrentWeek();
    return Math.min(week, totalWeeks);
  }, [totalWeeks]);

  const hasRealData = phases.length > 0;

  const stats = [
    { label: "Total Phases", value: hasRealData ? String(phases.length) : "7" },
    { label: "Milestones", value: hasRealData ? String(milestones.length) : "3" },
    { label: "Timeline", value: `${totalWeeks} weeks` },
    { label: "Current Week", value: String(currentWeek) },
  ];

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
          <Calendar className="w-5 h-5 text-[var(--accent-blue)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Timeline</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {isLoading
              ? "Loading timeline..."
              : hasRealData
                ? "Project roadmap from business goals"
                : "Project roadmap, phases, and milestones"}
          </p>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[color-mix(in_srgb,var(--accent-red)_10%,var(--bg-card))] border border-[var(--accent-red)]/20">
          <AlertCircle className="w-5 h-5 text-[var(--accent-red)] shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Failed to load goals</p>
            <p className="text-xs text-[var(--text-secondary)]">
              Unable to fetch goal data from the API. Showing default timeline.
            </p>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {stats.map((stat) => (
          <Card
            key={stat.label}
            className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none"
          >
            <CardContent className="py-3 px-4">
              <p className="text-xs text-[var(--text-muted)]">{stat.label}</p>
              <p className="text-lg font-semibold text-[var(--text-primary)] mt-0.5">
                {stat.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Gantt Chart */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
              Project Roadmap
            </CardTitle>
            <Badge
              variant="outline"
              className="border-[var(--accent-green)]/30 text-[var(--accent-green)] text-[10px]"
            >
              Week {currentWeek} of {totalWeeks}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-full bg-[var(--bg-secondary)]" />
              <Skeleton className="h-6 w-3/4 bg-[var(--bg-secondary)]" />
              <Skeleton className="h-40 w-full bg-[var(--bg-secondary)]" />
              <Skeleton className="h-6 w-3/4 bg-[var(--bg-secondary)]" />
              <Skeleton className="h-32 w-full bg-[var(--bg-secondary)]" />
              <Skeleton className="h-6 w-3/4 bg-[var(--bg-secondary)]" />
              <Skeleton className="h-24 w-full bg-[var(--bg-secondary)]" />
            </div>
          ) : (
            <GanttChart
              phases={hasRealData ? phases : undefined}
              milestones={hasRealData ? milestones : undefined}
              currentWeek={currentWeek}
              totalWeeks={totalWeeks}
            />
          )}
        </CardContent>
      </Card>

      {/* Legend */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">Legend</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4">
            {legendItems.map((item) => (
              <div key={item.label} className="flex items-center gap-2">
                {item.isMilestone ? (
                  <span
                    className="inline-block w-2.5 h-2.5 rotate-45"
                    style={{ backgroundColor: item.color }}
                  />
                ) : item.isIndicator ? (
                  <span
                    className="inline-block w-0.5 h-4 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                ) : (
                  <span
                    className="inline-block w-4 h-2.5 rounded-sm"
                    style={{
                      backgroundColor: `color-mix(in srgb, ${item.color} 40%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${item.color} 60%, transparent)`,
                    }}
                  />
                )}
                <span className="text-xs text-[var(--text-muted)]">{item.label}</span>
              </div>
            ))}
          </div>

          <Separator className="my-3 bg-[var(--border-mabos)]" />

          <p className="text-[10px] text-[var(--text-muted)]">
            Bars show phase duration with progress fill. Diamond markers indicate key milestones.
            The green vertical line marks the current week. Hover over any item for details.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
