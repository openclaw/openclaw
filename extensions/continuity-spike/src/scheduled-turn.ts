import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { requireCondition } from "./state-helpers.js";

type Workflow = OpenClawPluginApi["session"]["workflow"];
type ScheduleHandle = NonNullable<Awaited<ReturnType<Workflow["scheduleSessionTurn"]>>>;

export type ScheduledTurn = {
  sessionKey: string;
  tag: string;
  generation: number;
  handle?: ScheduleHandle;
  cleanupRequired: boolean;
  pending?: Promise<unknown>;
  cancelled: boolean;
  cancelling?: Promise<void>;
};

/** Creation's owner calls this after scheduling settles; never await job.pending here. */
export function cancelScheduledTurn(
  job: ScheduledTurn,
  workflow: Pick<Workflow, "unscheduleSessionTurnsByTag">,
): Promise<void> {
  job.cancelled = true;
  if (job.cancelling) {
    return job.cancelling;
  }
  if (!job.cleanupRequired) {
    return Promise.resolve();
  }
  const task = (async () => {
    const result = await workflow.unscheduleSessionTurnsByTag({
      sessionKey: job.sessionKey,
      tag: job.tag,
    });
    // A retired registry's facade may return 0/0 without checking Cron.
    // Neither a missing handle nor zero removals proves physical absence.
    requireCondition(result.failed === 0 && result.removed > 0, "scheduled-turn-cleanup-failed");
    job.handle = undefined;
    job.cleanupRequired = false;
  })();
  job.cancelling = task;
  void task
    .finally(() => {
      if (job.cancelling === task) {
        job.cancelling = undefined;
      }
    })
    .catch(() => {});
  return task;
}
