import { Clock } from "lucide-react";
import { CronBadge } from "@/components/cron/CronBadge";
import { cronToHuman, nextRunFromNow } from "@/lib/cron-utils";
import type { Workflow } from "@/lib/types";

type ScheduleTabProps = {
  workflow: Workflow;
};

export function ScheduleTab({ workflow }: ScheduleTabProps) {
  const sortedSteps = [...workflow.steps].sort((a, b) => a.order - b.order);
  const scheduledSteps = sortedSteps.filter((s) => s.schedule?.cronExpression);

  return (
    <div className="space-y-5">
      {/* Workflow-level schedule */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
          Workflow Schedule
        </p>
        {workflow.schedule ? (
          <CronBadge schedule={workflow.schedule} variant="full" />
        ) : (
          <p className="text-sm text-[var(--text-muted)] italic">No workflow-level schedule</p>
        )}
      </div>

      {/* Step schedules */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
          Step Schedules ({scheduledSteps.length} of {sortedSteps.length})
        </p>
        <div className="space-y-2">
          {sortedSteps.map((step, idx) => {
            const hasSchedule = !!step.schedule?.cronExpression;
            return (
              <div
                key={step.id}
                className="flex items-center gap-3 p-2.5 rounded-lg border"
                style={{
                  backgroundColor: hasSchedule
                    ? "color-mix(in srgb, var(--accent-blue) 5%, var(--bg-secondary))"
                    : "var(--bg-secondary)",
                  borderColor: hasSchedule
                    ? "color-mix(in srgb, var(--accent-blue) 20%, var(--border-mabos))"
                    : "var(--border-mabos)",
                }}
              >
                {/* Step number */}
                <div
                  className="flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold shrink-0"
                  style={{
                    backgroundColor: hasSchedule
                      ? "color-mix(in srgb, var(--accent-blue) 15%, transparent)"
                      : "color-mix(in srgb, var(--text-muted) 10%, transparent)",
                    color: hasSchedule ? "var(--accent-blue)" : "var(--text-muted)",
                  }}
                >
                  {idx + 1}
                </div>

                {/* Step info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-[var(--text-primary)] truncate">{step.name}</span>
                    {step.action && (
                      <span className="text-[10px] text-[var(--accent-purple)] bg-[color-mix(in_srgb,var(--accent-purple)_8%,transparent)] px-1.5 py-0.5 rounded font-mono shrink-0">
                        {step.action}
                      </span>
                    )}
                  </div>
                  {hasSchedule && (
                    <div className="flex items-center gap-2 mt-0.5">
                      <Clock className="w-2.5 h-2.5 text-[var(--accent-blue)]" />
                      <span className="text-[10px] text-[var(--text-secondary)]">
                        {cronToHuman(step.schedule!.cronExpression)}
                      </span>
                      {nextRunFromNow(step.schedule!.cronExpression) && (
                        <span className="text-[10px] text-[var(--text-muted)]">
                          — {nextRunFromNow(step.schedule!.cronExpression)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {sortedSteps.length === 0 && (
            <p className="text-sm text-[var(--text-muted)] italic">No steps defined.</p>
          )}
        </div>
      </div>

      {/* Schedule summary */}
      {scheduledSteps.length > 0 && (
        <div
          className="p-3 rounded-lg text-xs text-[var(--text-secondary)]"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent-blue) 5%, var(--bg-secondary))",
            border: "1px solid color-mix(in srgb, var(--accent-blue) 15%, transparent)",
          }}
        >
          <p className="font-medium text-[var(--text-primary)] mb-1">Schedule Summary</p>
          <p>
            {scheduledSteps.length} automated step{scheduledSteps.length !== 1 ? "s" : ""} with cron
            schedules.
          </p>
          {workflow.schedule?.timezone && (
            <p className="text-[var(--text-muted)] mt-0.5">
              Timezone: {workflow.schedule.timezone}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
