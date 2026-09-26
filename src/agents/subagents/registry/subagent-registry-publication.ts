import { sessionChanges } from "../../../sessions/session-row-changes.js";

let revision = 0;
const listeners = new Set<(runIds: readonly string[] | undefined) => void>();

export function subscribeSubagentRunChanges(
  listener: (runIds: readonly string[] | undefined) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read projections reuse registry facts until an owner publishes a mutation. */
export function getSubagentRegistryPublicationRevision(): number {
  return revision;
}

export function publishSubagentRunChanges(
  keys?: readonly (string | undefined)[],
  runIds?: readonly string[],
): void {
  // Synchronous session observers may read the registry before publication returns.
  revision++;
  for (const listener of listeners) {
    listener(runIds);
  }
  if (!keys?.length) {
    sessionChanges.emit({ all: true, scope: "subagent-runs" });
  }
  for (const sessionKey of new Set(keys)) {
    if (sessionKey) {
      sessionChanges.emit({ sessionKey, scope: "runtime" });
    }
  }
}
