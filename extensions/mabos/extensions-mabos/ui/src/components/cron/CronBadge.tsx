import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cronToHuman, nextRunFromNow } from "@/lib/cron-utils";
import type { CronScheduleInfo } from "@/lib/types";

type CronBadgeProps = {
  schedule: CronScheduleInfo;
  variant?: "compact" | "full";
};

export function CronBadge({ schedule, variant = "compact" }: CronBadgeProps) {
  const human = cronToHuman(schedule.cronExpression);
  const next = nextRunFromNow(schedule.cronExpression, schedule.timezone);

  if (variant === "compact") {
    return (
      <Badge
        variant="outline"
        className="text-[10px] gap-1 font-normal"
        style={{
          borderColor: schedule.enabled
            ? "color-mix(in srgb, var(--accent-blue) 40%, transparent)"
            : "color-mix(in srgb, var(--text-muted) 30%, transparent)",
          color: schedule.enabled ? "var(--accent-blue)" : "var(--text-muted)",
          opacity: schedule.enabled ? 1 : 0.6,
        }}
      >
        <Clock className="w-2.5 h-2.5" />
        {human}
      </Badge>
    );
  }

  // Full variant
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs"
      style={{
        backgroundColor: schedule.enabled
          ? "color-mix(in srgb, var(--accent-blue) 8%, transparent)"
          : "color-mix(in srgb, var(--text-muted) 5%, transparent)",
        border: `1px solid ${schedule.enabled ? "color-mix(in srgb, var(--accent-blue) 20%, transparent)" : "color-mix(in srgb, var(--text-muted) 15%, transparent)"}`,
      }}
    >
      <Clock
        className="w-3.5 h-3.5 shrink-0"
        style={{ color: schedule.enabled ? "var(--accent-blue)" : "var(--text-muted)" }}
      />
      <div className="flex flex-col">
        <span
          className="font-medium"
          style={{ color: schedule.enabled ? "var(--text-primary)" : "var(--text-muted)" }}
        >
          {human}
        </span>
        {next && <span className="text-[10px] text-[var(--text-muted)]">Next: {next}</span>}
      </div>
      {!schedule.enabled && (
        <span className="text-[10px] text-[var(--text-muted)] ml-auto">paused</span>
      )}
    </div>
  );
}
