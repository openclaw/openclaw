import { useMemo, useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// --- Types ---

export type Phase = {
  id: string;
  label: string;
  phase: string;
  startWeek: number;
  durationWeeks: number;
  color: string;
};

export type Milestone = {
  id: string;
  label: string;
  week: number;
  color: string;
};

// --- Default mock data ---

const defaultPhases: Phase[] = [
  {
    id: "p1",
    label: "Business Setup",
    phase: "Foundation",
    startWeek: 0,
    durationWeeks: 4,
    color: "var(--accent-blue)",
  },
  {
    id: "p2",
    label: "Agent Deployment",
    phase: "Foundation",
    startWeek: 2,
    durationWeeks: 6,
    color: "var(--accent-purple)",
  },
  {
    id: "p3",
    label: "Market Analysis",
    phase: "Growth",
    startWeek: 4,
    durationWeeks: 8,
    color: "var(--accent-green)",
  },
  {
    id: "p4",
    label: "Product Launch",
    phase: "Growth",
    startWeek: 8,
    durationWeeks: 6,
    color: "var(--accent-orange)",
  },
  {
    id: "p5",
    label: "Customer Acquisition",
    phase: "Growth",
    startWeek: 10,
    durationWeeks: 10,
    color: "var(--accent-green)",
  },
  {
    id: "p6",
    label: "Revenue Optimization",
    phase: "Optimization",
    startWeek: 16,
    durationWeeks: 8,
    color: "var(--accent-purple)",
  },
  {
    id: "p7",
    label: "Scale Operations",
    phase: "Optimization",
    startWeek: 20,
    durationWeeks: 6,
    color: "var(--accent-blue)",
  },
];

const defaultMilestones: Milestone[] = [
  { id: "m1", label: "MVP Ready", week: 4, color: "var(--accent-green)" },
  { id: "m2", label: "First Sale", week: 12, color: "var(--accent-orange)" },
  { id: "m3", label: "Break Even", week: 20, color: "var(--accent-purple)" },
];

const DEFAULT_TOTAL_WEEKS = 26;
const LABEL_WIDTH = 200;

// --- Helpers ---

function groupByPhase(phases: Phase[]): Map<string, Phase[]> {
  const map = new Map<string, Phase[]>();
  for (const p of phases) {
    const group = map.get(p.phase) ?? [];
    group.push(p);
    map.set(p.phase, group);
  }
  return map;
}

function getMonthLabels(totalWeeks: number): { label: string; offsetPct: number }[] {
  const labels: { label: string; offsetPct: number }[] = [];
  const months = ["Month 1", "Month 2", "Month 3", "Month 4", "Month 5", "Month 6", "Month 7"];
  for (let i = 0; i < Math.ceil(totalWeeks / 4); i++) {
    labels.push({
      label: months[i] ?? `Month ${i + 1}`,
      offsetPct: ((i * 4) / totalWeeks) * 100,
    });
  }
  return labels;
}

// --- Component ---

type GanttChartProps = {
  phases?: Phase[];
  milestones?: Milestone[];
  currentWeek?: number;
  totalWeeks?: number;
};

export function GanttChart({
  phases = defaultPhases,
  milestones = defaultMilestones,
  currentWeek = 8,
  totalWeeks = DEFAULT_TOTAL_WEEKS,
}: GanttChartProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const TOTAL_WEEKS = totalWeeks;

  const grouped = useMemo(() => groupByPhase(phases), [phases]);
  const monthLabels = useMemo(() => getMonthLabels(TOTAL_WEEKS), [TOTAL_WEEKS]);

  // Build flat rows for rendering, with phase group headers
  const rows = useMemo(() => {
    const result: Array<
      | { type: "header"; phase: string }
      | { type: "bar"; item: Phase }
      | { type: "milestone"; item: Milestone }
    > = [];

    for (const [phaseName, items] of grouped) {
      result.push({ type: "header", phase: phaseName });
      for (const item of items) {
        result.push({ type: "bar", item });
      }
      // Add milestones that fall within the phase's time range
      const phaseStart = Math.min(...items.map((i) => i.startWeek));
      const phaseEnd = Math.max(...items.map((i) => i.startWeek + i.durationWeeks));
      for (const m of milestones) {
        if (m.week >= phaseStart && m.week <= phaseEnd) {
          result.push({ type: "milestone", item: m });
        }
      }
    }

    return result;
  }, [grouped, milestones]);

  const currentWeekPct = (currentWeek / TOTAL_WEEKS) * 100;

  return (
    <TooltipProvider delayDuration={100}>
      <div className="w-full overflow-x-auto">
        <div className="min-w-[700px]">
          {/* Time axis header */}
          <div className="flex border-b border-[var(--border-mabos)]">
            <div
              className="shrink-0 text-xs font-medium text-[var(--text-muted)] px-3 py-2"
              style={{ width: LABEL_WIDTH }}
            >
              Task
            </div>
            <div className="relative flex-1 py-2">
              {/* Month labels */}
              {monthLabels.map((m) => (
                <span
                  key={m.label}
                  className="absolute text-xs text-[var(--text-muted)]"
                  style={{ left: `${m.offsetPct}%` }}
                >
                  {m.label}
                </span>
              ))}
            </div>
          </div>

          {/* Week grid ticks */}
          <div className="flex">
            <div className="shrink-0" style={{ width: LABEL_WIDTH }} />
            <div className="relative flex-1 h-0">
              {/* Vertical grid lines every 4 weeks */}
              {monthLabels.map((m) => (
                <div
                  key={`grid-${m.label}`}
                  className="absolute top-0 h-[999px] border-l border-[var(--border-mabos)]/30"
                  style={{ left: `${m.offsetPct}%` }}
                />
              ))}
              {/* Current week indicator */}
              <div
                className="absolute top-0 h-[999px] border-l-2 border-[var(--accent-green)] z-10"
                style={{ left: `${currentWeekPct}%` }}
              >
                <div
                  className="absolute -top-0.5 -left-[7px] w-3.5 h-3.5 rounded-full"
                  style={{ backgroundColor: "var(--accent-green)" }}
                />
              </div>
            </div>
          </div>

          {/* Rows */}
          <div className="relative">
            {rows.map((row, _idx) => {
              if (row.type === "header") {
                return (
                  <div
                    key={`header-${row.phase}`}
                    className="flex items-center border-b border-[var(--border-mabos)]/20 mt-2"
                  >
                    <div
                      className="shrink-0 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]"
                      style={{ width: LABEL_WIDTH }}
                    >
                      {row.phase}
                    </div>
                    <div className="flex-1" />
                  </div>
                );
              }

              if (row.type === "milestone") {
                const m = row.item as Milestone;
                const leftPct = (m.week / TOTAL_WEEKS) * 100;
                const isHovered = hoveredId === m.id;

                return (
                  <div
                    key={m.id}
                    className="flex items-center h-9"
                    onMouseEnter={() => setHoveredId(m.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    <div
                      className="shrink-0 px-3 text-xs text-[var(--text-secondary)] truncate flex items-center gap-2"
                      style={{ width: LABEL_WIDTH }}
                    >
                      <span
                        className="inline-block w-2 h-2 rotate-45 shrink-0"
                        style={{ backgroundColor: m.color }}
                      />
                      {m.label}
                    </div>
                    <div className="relative flex-1 h-full flex items-center">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            className="absolute w-3 h-3 rotate-45 cursor-pointer transition-transform"
                            style={{
                              left: `calc(${leftPct}% - 6px)`,
                              backgroundColor: m.color,
                              transform: `rotate(45deg) ${isHovered ? "scale(1.4)" : "scale(1)"}`,
                              boxShadow: isHovered ? `0 0 8px ${m.color}` : "none",
                            }}
                          />
                        </TooltipTrigger>
                        <TooltipContent
                          side="top"
                          className="bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border-mabos)]"
                        >
                          <p className="font-medium">{m.label}</p>
                          <p className="text-[var(--text-muted)] text-[10px]">Week {m.week}</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              }

              // Bar row
              const p = row.item as Phase;
              const leftPct = (p.startWeek / TOTAL_WEEKS) * 100;
              const widthPct = (p.durationWeeks / TOTAL_WEEKS) * 100;
              const isHovered = hoveredId === p.id;

              // Calculate progress based on current week
              const progressPct = Math.min(
                100,
                Math.max(0, ((currentWeek - p.startWeek) / p.durationWeeks) * 100),
              );

              return (
                <div
                  key={p.id}
                  className="flex items-center h-10"
                  onMouseEnter={() => setHoveredId(p.id)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  <div
                    className="shrink-0 px-3 text-xs text-[var(--text-secondary)] truncate"
                    style={{ width: LABEL_WIDTH }}
                  >
                    {p.label}
                  </div>
                  <div className="relative flex-1 h-full flex items-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div
                          className="absolute h-6 rounded cursor-pointer transition-all"
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            backgroundColor: `color-mix(in srgb, ${p.color} 25%, transparent)`,
                            border: `1px solid color-mix(in srgb, ${p.color} 40%, transparent)`,
                            transform: isHovered ? "scaleY(1.15)" : "scaleY(1)",
                            boxShadow: isHovered
                              ? `0 0 12px color-mix(in srgb, ${p.color} 30%, transparent)`
                              : "none",
                          }}
                        >
                          {/* Progress fill */}
                          <div
                            className="absolute inset-0 rounded"
                            style={{
                              width: `${progressPct}%`,
                              backgroundColor: `color-mix(in srgb, ${p.color} 50%, transparent)`,
                            }}
                          />
                          {/* Label inside bar if wide enough */}
                          {widthPct > 12 && (
                            <span className="absolute inset-0 flex items-center px-2 text-[10px] font-medium text-[var(--text-primary)] truncate z-10">
                              {p.label}
                            </span>
                          )}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        className="bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border-mabos)]"
                      >
                        <div className="space-y-1">
                          <p className="font-medium">{p.label}</p>
                          <p className="text-[var(--text-muted)] text-[10px]">Phase: {p.phase}</p>
                          <p className="text-[var(--text-muted)] text-[10px]">
                            Week {p.startWeek} - Week {p.startWeek + p.durationWeeks} (
                            {p.durationWeeks} weeks)
                          </p>
                          <p className="text-[var(--text-muted)] text-[10px]">
                            Progress: {Math.round(progressPct)}%
                          </p>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
