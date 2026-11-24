import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.types.js";

type PreparedModelRuntimeReadBatch = {
  configuredOwners: WeakMap<
    Map<string, PreparedModelRuntimeOwner>,
    Map<string, PreparedModelRuntimeOwner[]>
  >;
  configFingerprints: WeakMap<OpenClawConfig, string>;
};

let activePreparedModelRuntimeReadBatch: PreparedModelRuntimeReadBatch | undefined;

/** Reuse configured candidates only during synchronous reads; never publish or yield here. */
export function withPreparedModelRuntimeReadBatch<T>(read: () => T): T {
  const parent = activePreparedModelRuntimeReadBatch;
  activePreparedModelRuntimeReadBatch = {
    configuredOwners: new WeakMap(),
    configFingerprints: new WeakMap(),
  };
  try {
    return read();
  } finally {
    activePreparedModelRuntimeReadBatch = parent;
  }
}

export function getPreparedModelRuntimeConfigFingerprint(
  config: OpenClawConfig,
  compute: () => string,
): string {
  const batch = activePreparedModelRuntimeReadBatch;
  const cached = batch?.configFingerprints.get(config);
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = compute();
  batch?.configFingerprints.set(config, fingerprint);
  return fingerprint;
}

export function configuredOwnerCandidates(
  owners: Map<string, PreparedModelRuntimeOwner>,
  agentId: string | undefined,
): Iterable<PreparedModelRuntimeOwner> {
  const batch = activePreparedModelRuntimeReadBatch;
  if (!batch || agentId === undefined) {
    return owners.values();
  }
  let byAgent = batch.configuredOwners.get(owners);
  if (!byAgent) {
    byAgent = new Map();
    for (const owner of owners.values()) {
      if (owner.provenance !== "configured" || owner.input.agentId === undefined) {
        continue;
      }
      const matches = byAgent.get(owner.input.agentId);
      if (matches) {
        matches.push(owner);
      } else {
        byAgent.set(owner.input.agentId, [owner]);
      }
    }
    batch.configuredOwners.set(owners, byAgent);
  }
  return byAgent.get(agentId) ?? [];
}
