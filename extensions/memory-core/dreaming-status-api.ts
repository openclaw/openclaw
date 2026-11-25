import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { MANAGED_DREAMING_DECLARATION_KEY } from "./src/dreaming-cron-contract.js";

type DreamingCronJob = {
  declarationKey?: string;
  enabled: boolean;
  state: { nextRunAtMs?: number };
};

/** Diagnostic reads do not register the plugin or initialize its memory runtime. */
export async function readMemoryCoreDreamingRuns(params: {
  workspaceDir: string;
  dreamingEnabled: boolean;
  cronEnabled: boolean;
  readCronJobs: () => Promise<readonly DreamingCronJob[]>;
}): Promise<string[]> {
  const lastRun = async () => {
    try {
      const { readMemoryHostEventRecords } = await import("openclaw/plugin-sdk/memory-host-events");
      const events = await readMemoryHostEventRecords({
        workspaceDir: params.workspaceDir,
        type: "memory.dream.completed",
        limit: 1,
      });
      // The bounded journal records phase outcomes, not every sweep or skipped attempt.
      const event = events.findLast((entry) => entry.type === "memory.dream.completed");
      return event
        ? `${new Date(event.timestamp).toISOString()} (${event.phase}, ${event.outcome ?? "completed"})`
        : "none recorded";
    } catch (error) {
      return `unavailable (${formatErrorMessage(error)})`;
    }
  };
  const nextRun = async () => {
    if (!params.dreamingEnabled) {
      return "dreaming disabled";
    }
    if (!params.cronEnabled) {
      return "cron disabled";
    }
    try {
      const jobs = await params.readCronJobs();
      const times = jobs.flatMap((job) =>
        job.declarationKey === MANAGED_DREAMING_DECLARATION_KEY &&
        job.enabled &&
        job.state.nextRunAtMs !== undefined
          ? [job.state.nextRunAtMs]
          : [],
      );
      return times.length > 0 ? new Date(Math.min(...times)).toISOString() : "none scheduled";
    } catch (error) {
      return `unavailable (${formatErrorMessage(error)})`;
    }
  };
  const [last, next] = await Promise.all([lastRun(), nextRun()]);
  return [`Last recorded dreaming run: ${last}.`, `Next scheduled run: ${next}.`];
}
