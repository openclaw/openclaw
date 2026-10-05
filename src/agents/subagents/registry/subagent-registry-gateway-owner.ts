import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver as getEntryGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** A closed Gateway's durable terminal wake acquires fresh host custody, never its old aliases. */
export async function recoverSubagentRunGatewayOwner(
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
