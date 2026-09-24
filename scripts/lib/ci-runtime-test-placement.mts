import type { CompactNodeTestShard, NodeTestShardGroup } from "./ci-node-test-plan.mts";

// Optimize complete existing jobs only; an unavailable placement never removes
// work or changes a runner anchor. The planner owns the shared admission policy.
export function rebalanceRuntimeTestJobs(
  jobs: CompactNodeTestShard[],
  {
    cost,
    admits,
    runnerRank,
    prepareRecipient,
  }: {
    cost: (groups: NodeTestShardGroup[]) => number;
    admits: (groups: NodeTestShardGroup[]) => boolean;
    runnerRank: (job: Pick<CompactNodeTestShard, "runner">) => number;
    prepareRecipient: (job: CompactNodeTestShard) => NodeTestShardGroup[] | undefined;
  },
) {
  const donors = jobs.filter((job) => job.pretestBuildMode === "runtime");
  for (const donor of donors.toSorted((a, b) => cost(b.groups) - cost(a.groups))) {
    if (admits(donor.groups)) {
      continue;
    }
    let best:
      | {
          recipient: CompactNodeTestShard;
          group: NodeTestShardGroup;
          groups: NodeTestShardGroup[];
          maximum: number;
          recipientSeconds: number;
        }
      | undefined;
    for (const group of donor.groups) {
      // An inherited job allowance could increase on a different host.
      if (
        group.pretestBuildMode !== "runtime" ||
        group.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined
      ) {
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
        const prepared = prepareRecipient(recipient);
        if (!prepared) {
          continue;
        }
        const combined = [...prepared, group];
        const recipientSeconds = cost(combined);
        const maximum = Math.max(cost(remaining), recipientSeconds);
        // When the retained donor dominates both choices, keep more receiver
        // headroom instead of selecting whichever job happened to appear first.
        if (
          admits(combined) &&
          (!best ||
            maximum < best.maximum ||
            (maximum === best.maximum &&
              (recipientSeconds < best.recipientSeconds ||
                (recipientSeconds === best.recipientSeconds &&
                  recipient.checkName.localeCompare(best.recipient.checkName) < 0))))
        ) {
          best = { recipient, group, groups: combined, maximum, recipientSeconds };
        }
      }
    }
    if (best) {
      const { recipient, group, groups } = best;
      donor.groups = donor.groups.filter((entry) => entry !== group);
      recipient.groups = groups;
      recipient.pretestBuildMode = "runtime";
      recipient.planConcurrency = 1;
    }
  }
  for (const job of jobs) {
    // An over-budget unchanged plan is still runnable; estimates are not gates
    // for test coverage. Only proposed replacements must satisfy admission.
    if (job.pretestBuildMode === "runtime") {
      job.predictedSeconds = Math.ceil(cost(job.groups));
    }
  }
}
