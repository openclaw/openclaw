import type { CompactNodeTestShard, NodeTestShardGroup } from "./ci-node-test-plan.mts";

// Optimize complete existing jobs only; an unavailable placement never removes
// work or changes a runner anchor. The planner owns the shared admission policy.
export function rebalanceRuntimeTestJobs(
  jobs: CompactNodeTestShard[],
  {
    cost,
    admits,
    runnerRank,
  }: {
    cost: (groups: NodeTestShardGroup[]) => number;
    admits: (groups: NodeTestShardGroup[]) => boolean;
    runnerRank: (job: Pick<CompactNodeTestShard, "runner">) => number;
  },
) {
  for (const donor of jobs.toSorted((a, b) => cost(b.groups) - cost(a.groups))) {
    if (admits(donor.groups)) {
      continue;
    }
    let best:
      | { recipient: CompactNodeTestShard; group: NodeTestShardGroup; maximum: number }
      | undefined;
    for (const group of donor.groups) {
      // An inherited job allowance could increase on a different host.
      if (group.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined) {
        continue;
      }
      const remaining = donor.groups.filter((entry) => entry !== group);
      if (!admits(remaining)) {
        continue;
      }
      for (const recipient of jobs) {
        // A group may already have a stronger placement than its declared class.
        if (recipient === donor || runnerRank(recipient) < runnerRank(donor)) {
          continue;
        }
        const combined = [...recipient.groups, group];
        const maximum = Math.max(cost(remaining), cost(combined));
        if (admits(combined) && (!best || maximum < best.maximum)) {
          best = { recipient, group, maximum };
        }
      }
    }
    if (best) {
      const { recipient, group } = best;
      donor.groups = donor.groups.filter((entry) => entry !== group);
      recipient.groups = [...recipient.groups, group];
    }
  }
  for (const job of jobs) {
    // An over-budget unchanged plan is still runnable; estimates are not gates
    // for test coverage. Only proposed replacements must satisfy admission.
    job.predictedSeconds = Math.ceil(cost(job.groups));
  }
}
