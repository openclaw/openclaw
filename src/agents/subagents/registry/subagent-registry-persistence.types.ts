import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentRunMutation } from "./subagent-registry-mutation.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentRegistryWriteAuthority = {
  assertCurrent: () => void;
  assertDatabase: () => void;
};

export type SubagentRunMutationOptions<P extends SubagentRunMutation<unknown>> = {
  runs?: Map<string, SubagentRunRecord>;
  context?: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
  pendingKillClaim?: SubagentRunRecord;
  gatewayRecovery?: {
    expected: SubagentRunRecord;
    previousResolver: GatewayContextResolver;
    resolver: GatewayContextResolver;
    gateway: NonNullable<ReturnType<GatewayContextResolver>>;
  };
  onPublished?: (
    postimages: ReadonlyMap<string, SubagentRunRecord | null>,
    value: P["value"],
  ) => void;
  commit?: (
    planned: P,
    versions: ReadonlyMap<string, string | null>,
    authority: SubagentRegistryWriteAuthority,
  ) => Promise<SubagentRunMutation<P["value"]>>;
};
