import { sessionChanges } from "../../../sessions/session-row-changes.js";

let revision = 0;

/** Read projections reuse registry facts until an owner publishes a mutation. */
export function getSubagentRegistryPublicationRevision(): number {
  return revision;
}

export function publishSubagentRunChanges(keys?: readonly (string | undefined)[]): void {
  // Synchronous session observers may read the registry before publication returns.
  revision++;
  if (!keys?.length) {
    sessionChanges.emit({ all: true, scope: "subagent-runs" });
  }
  for (const sessionKey of new Set(keys)) {
    if (sessionKey) {
      sessionChanges.emit({ sessionKey });
    }
  }
}
