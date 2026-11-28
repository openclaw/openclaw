import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeOwner,
} from "./prepared-model-runtime.types.js";

/** Configured owners that own an agent's catalog identity, independent of the run's workspace. */
export function findConfiguredOwnerCandidates(
  owners: Map<string, PreparedModelRuntimeOwner>,
  input: PreparedModelRuntimeInput,
): PreparedModelRuntimeOwner[] {
  const configured = [...owners.values()].filter((owner) => owner.provenance === "configured");
  const identityCandidates =
    input.agentId === undefined
      ? []
      : configured.filter((owner) => owner.input.agentId === input.agentId);
  const exactCandidates = identityCandidates.filter(
    (owner) => owner.input.agentDir === input.agentDir,
  );
  const directoryCandidates = configured.filter((owner) => owner.input.agentDir === input.agentDir);
  // Unbound inputs and reserved setup identities derive ownership from the configured directory.
  // Ordinary agent runs stay bound to their explicit identity, even when handed a stale directory.
  const canRebindByDirectory =
    input.agentId === undefined || isReservedSystemAgentId(input.agentId);
  return exactCandidates.length > 0
    ? exactCandidates
    : canRebindByDirectory && directoryCandidates.length > 0
      ? directoryCandidates
      : identityCandidates;
}
