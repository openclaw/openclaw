"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CardSkeleton } from "@/components/composed";
import { useCronJobsByAgent, useCronStatus } from "@/hooks/queries/useCron";

interface AgentCronTabProps {
  agentId: string;
}

function formatTimestamp(value?: string) {
  if (!value) {
    return "n/a";
  }
  return new Date(value).toLocaleString();
}

export function AgentCronTab({ agentId }: AgentCronTabProps) {
  const { data: jobsResult, isLoading, error } = useCronJobsByAgent(agentId);
  const { data: status } = useCronStatus();

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/50 bg-destructive/10">
        <CardContent className="p-6 text-center">
          <p className="text-destructive">Failed to load cron jobs</p>
        </CardContent>
      </Card>
    );
  }

  const jobs = jobsResult?.jobs ?? [];

  return (
    <div className="space-y-6">
      <Card className="border-border/50">
        <CardContent className="pt-6 space-y-4">
          <div>
            <h3 className="text-lg font-semibold">Scheduler</h3>
            <p className="text-sm text-muted-foreground">Gateway cron status.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-border/50 p-3 text-center">
              <p className="text-xs text-muted-foreground">Enabled</p>
              <p className="text-lg font-semibold">{status ? (status.enabled ? "Yes" : "No") : "n/a"}</p>
            </div>
            <div className="rounded-lg border border-border/50 p-3 text-center">
              <p className="text-xs text-muted-foreground">Jobs</p>
              <p className="text-lg font-semibold">{status?.totalJobs ?? "n/a"}</p>
            </div>
            <div className="rounded-lg border border-border/50 p-3 text-center">
              <p className="text-xs text-muted-foreground">Next wake</p>
              <p className="text-lg font-semibold">{status?.nextRunAt ? formatTimestamp(status.nextRunAt) : "n/a"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardContent className="pt-6 space-y-4">
          <div>
            <h3 className="text-lg font-semibold">Agent Cron Jobs</h3>
            <p className="text-sm text-muted-foreground">
              Scheduled jobs targeting this agent.
            </p>
          </div>
          {jobs.length === 0 ? (
            <div className="text-sm text-muted-foreground">No jobs assigned.</div>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => {
                const lastResult = job.lastResult?.success;
                return (
                  <div
                    key={job.id}
                    className="rounded-lg border border-border/50 p-4 space-y-2"
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="text-base font-semibold">{job.name}</div>
                        {job.description && (
                          <p className="text-sm text-muted-foreground">{job.description}</p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs">
                        <Badge variant={job.enabled ? "success" : "warning"}>
                          {job.enabled ? "enabled" : "disabled"}
                        </Badge>
                        <Badge variant="secondary">{job.schedule}</Badge>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Message: <span className="text-foreground">{job.message}</span>
                    </div>
                    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                      <span>Last run: {formatTimestamp(job.lastRunAt)}</span>
                      <span>Next run: {formatTimestamp(job.nextRunAt)}</span>
                      <span>
                        Status:{" "}
                        {lastResult === undefined ? (
                          "n/a"
                        ) : lastResult ? (
                          <span className="text-success">success</span>
                        ) : (
                          <span className="text-error">failed</span>
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default AgentCronTab;
