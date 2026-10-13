import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import type { createDeferredCore } from "../../../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { DomainScope } from "../../../state/openclaw-state-worker-store.types.js";
import type { SubagentRunMutation } from "./subagent-registry-mutation.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentRegistryWriteFailure = Error & {
  readonly outcome: "not-committed" | "committed" | "unknown";
  readonly publication?: "published" | "superseded";
};

export type PendingRegistryWrite = {
  runIds: ReadonlySet<string>;
  admission: OpenClawStateWorkerContext["admission"];
  settled: ReturnType<typeof createDeferredCore<void>>;
  uncertain?: SubagentRegistryWriteFailure;
  killClaim?: SubagentRunRecord;
  rekeys?: Array<{
    from: string;
    to: string;
    owner: object;
    sourceIdentity: string;
    destinationIdentity: string;
  }>;
};

export type RegistrySourceQueue = {
  admission: OpenClawStateWorkerContext["admission"];
  tails: Map<string, Promise<void>>;
  restore?: Promise<void>;
};

export type SubagentRegistryWriteAuthority = {
  assertCurrent: () => void;
  assertDatabase: () => void;
};

export type SubagentRunMutationOptions<P extends SubagentRunMutation<unknown>> = {
  runs?: Map<string, SubagentRunRecord>;
  preparedRows?: ReadonlyMap<string, SubagentRunRecord>;
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

export type SubagentRegistryWorkerWrite<T> = {
  writeId: string;
  assertCurrent: () => void;
  execute: (scope: DomainScope) => Promise<unknown>;
  decode: (value: unknown) => T;
} & (
  | {
      kind: "registry";
      terminalEvents: SubagentRunMutation<unknown>["terminalEvents"];
      acknowledged: () => boolean;
    }
  | { kind: "completion" }
);
