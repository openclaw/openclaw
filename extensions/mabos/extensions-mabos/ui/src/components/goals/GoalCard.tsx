import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { BusinessGoal, GoalLevel, GoalState } from "@/lib/types";
import { WorkflowSteps } from "./WorkflowSteps";

const levelColors: Record<GoalLevel, string> = {
  strategic: "var(--accent-purple)",
  tactical: "var(--accent-blue)",
  operational: "var(--accent-orange)",
};

const stateColors: Record<GoalState, string> = {
  pending: "var(--text-muted)",
  active: "var(--accent-green)",
  in_progress: "var(--accent-blue)",
  achieved: "var(--accent-green)",
  failed: "var(--accent-red)",
  suspended: "var(--accent-orange)",
  abandoned: "var(--text-muted)",
};

const stateLabels: Record<GoalState, string> = {
  pending: "Pending",
  active: "Active",
  in_progress: "In Progress",
  achieved: "Achieved",
  failed: "Failed",
  suspended: "Suspended",
  abandoned: "Abandoned",
};

type GoalCardProps = {
  goal: BusinessGoal;
  onSelect?: (goalId: string) => void;
};

function PriorityRing({ value, size = 52 }: { value: number; size?: number }) {
  const strokeWidth = 5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * value;
  const gap = circumference - filled;
  const gradientId = `ring-grad-${Math.random().toString(36).slice(2, 8)}`;

  return (
    <div
      className="relative flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="block -rotate-90">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--accent-blue)" />
            <stop offset="100%" stopColor="var(--accent-green)" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border-mabos)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={strokeWidth}
          strokeDasharray={`${filled} ${gap}`}
          strokeLinecap="round"
        />
      </svg>
      <span
        className="absolute font-bold text-[var(--text-primary)]"
        style={{ fontSize: size * 0.28 }}
      >
        {(value * 100).toFixed(0)}%
      </span>
    </div>
  );
}

export function GoalCard({ goal, onSelect }: GoalCardProps) {
  const borderColor = levelColors[goal.level];
  const goalState = goal.goalState ?? "active";
  const stateColor = stateColors[goalState] ?? stateColors.active;

  return (
    <Card
      className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4 cursor-pointer hover:border-[var(--border-hover)] transition-colors"
      onClick={() => onSelect?.(goal.id)}
    >
      <CardContent className="space-y-3">
        {/* Header row with ring chart */}
        <div className="flex items-start gap-3">
          <PriorityRing value={goal.priority} />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium text-[var(--text-primary)]">{goal.name}</h3>
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge
                  variant="outline"
                  className="text-[10px] capitalize"
                  style={{
                    borderColor: `color-mix(in srgb, ${stateColor} 40%, transparent)`,
                    color: stateColor,
                  }}
                >
                  {stateLabels[goalState] ?? goalState}
                </Badge>
                <Badge
                  variant="outline"
                  className="text-[10px] capitalize"
                  style={{
                    borderColor: `color-mix(in srgb, ${borderColor} 40%, transparent)`,
                    color: borderColor,
                  }}
                >
                  {goal.level}
                </Badge>
                <Badge
                  variant="outline"
                  className="text-[10px] border-[var(--border-mabos)] text-[var(--text-muted)]"
                >
                  {goal.type}
                </Badge>
              </div>
            </div>

            {/* Description */}
            {goal.description && (
              <p className="text-xs text-[var(--text-secondary)] line-clamp-2 mt-1">
                {goal.description}
              </p>
            )}
          </div>
        </div>

        {/* Desires */}
        {goal.desires && goal.desires.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {goal.desires.map((desire) => (
              <span
                key={desire}
                className="px-2 py-0.5 text-[10px] rounded-full text-[var(--accent-purple)]"
                style={{
                  backgroundColor: `color-mix(in srgb, var(--accent-purple) 10%, transparent)`,
                }}
              >
                {desire}
              </span>
            ))}
          </div>
        )}

        {/* Preconditions */}
        {goal.preconditions && goal.preconditions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {goal.preconditions.map((pc) => (
              <span
                key={pc.id}
                className="px-2 py-0.5 text-[10px] rounded-full inline-flex items-center gap-1"
                style={{
                  color: pc.satisfied ? "var(--accent-green)" : "var(--accent-orange)",
                  backgroundColor: pc.satisfied
                    ? "color-mix(in srgb, var(--accent-green) 10%, transparent)"
                    : "color-mix(in srgb, var(--accent-orange) 10%, transparent)",
                }}
              >
                <span>{pc.satisfied ? "\u2713" : "\u25CB"}</span>
                {pc.name}
              </span>
            ))}
          </div>
        )}

        {/* Workflows */}
        {goal.workflows && goal.workflows.length > 0 && (
          <div className="space-y-2 pt-1">
            {goal.workflows.map((workflow) => (
              <WorkflowSteps key={workflow.id} workflow={workflow} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
