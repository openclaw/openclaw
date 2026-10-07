import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver as getEntryGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

/** A closed Gateway's durable terminal wake acquires fresh host custody, never its old aliases. */
async function recoverSubagentRunGatewayOwner(
  expected: SubagentRunRecord,
  resolver: GatewayContextResolver,
  onRecovered: (entry: SubagentRunRecord) => void,
): Promise<boolean> {
  const previousResolver = getEntryGatewayContextResolver(expected);
  const gateway = resolver();
  if (!previousResolver || previousResolver() !== undefined || !gateway) {
    return false;
  }
  return mutateSubagentRuns(
    [expected.runId],
    (rows) => {
      const current = rows.get(expected.runId);
      if (!current) {
        throw new SubagentRegistryMutationRejectedError(
          "Subagent Gateway recovery row disappeared",
        );
      }
      return { value: true, postimages: new Map([[current.runId, structuredClone(current)]]) };
    },
    {
      gatewayRecovery: { expected, previousResolver, resolver, gateway },
      onPublished: (postimages) => {
        const row = postimages.get(expected.runId);
        if (row) {
          bindGatewayContextResolver(row, resolver);
          onRecovered(row);
          subagentRuns.commitOwnership(row);
        }
      },
    },
  );
}

/** Bind only the captured inventory, retaining the same Gateway across batch yields. */
export async function bindSubagentRunGatewayOwners(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<object>;
  getGatewayContextResolver: () => GatewayContextResolver | undefined;
  onRecovered: (entry: SubagentRunRecord) => void;
}): Promise<boolean> {
  const resolver = params.getGatewayContextResolver();
  const gateway = resolver?.();
  if (!resolver || !gateway) {
    return false;
  }
  const isCurrent = () => params.getGatewayContextResolver() === resolver && resolver() === gateway;
  // New registrations during a yield belong to the next pass, not this captured owner set.
  const capturedRuns = [...params.runs.values()];
  let visited = 0;
  for (const snapshot of capturedRuns) {
    if (++visited % 128 === 0) {
      await yieldToEventLoop();
      if (!isCurrent()) {
        return false;
      }
    }
    const entry = getCurrentSubagentRunOwner(params.runs, snapshot);
    if (!entry) {
      continue;
    }
    const previous = getEntryGatewayContextResolver(entry);
    if (previous) {
      if (entry.execution.status !== "terminal" || !entry.requesterSettleWake || previous()) {
        continue;
      }
      const previousResumeKey = getSubagentRunRuntimeKey(entry);
      if (await recoverSubagentRunGatewayOwner(entry, resolver, params.onRecovered)) {
        params.resumedRuns.delete(previousResumeKey);
      }
      if (!isCurrent()) {
        return false;
      }
      continue;
    }
    bindGatewayContextResolver(entry, resolver);
    subagentRuns.commitOwnership(entry);
  }
  return isCurrent();
}
