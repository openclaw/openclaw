import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { notifyListeners, registerListener } from "../../../shared/listeners.js";

let revision = 0;
type Publication = {
  runIds: readonly string[] | undefined;
  sessionKeys: readonly (string | undefined)[] | undefined;
};
const listeners = {
  projection: new Set<(event: Publication) => void>(),
  persistence: new Set<(event: Publication) => void>(),
};

export function subscribeSubagentRunChanges(
  phase: keyof typeof listeners,
  listener: (event: Publication) => void,
) {
  return registerListener(listeners[phase], listener);
}

/** Read projections reuse registry facts until an owner publishes a mutation. */
export function getSubagentRegistryPublicationRevision(): number {
  return revision;
}

export function publishSubagentRunChanges(
  keys?: readonly (string | undefined)[],
  runIds?: readonly string[],
  source: "memory" | "persistence" = "memory",
): void {
  // Synchronous session observers may read the registry before publication returns.
  revision++;
  const event = { runIds, sessionKeys: keys };
  for (const listener of listeners.projection) {
    listener(event);
  }
  if (!keys?.length) {
    sessionChanges.emit({ all: true, scope: "subagent-runs" });
  }
  for (const sessionKey of new Set(keys)) {
    if (sessionKey) {
      sessionChanges.emit({ sessionKey, scope: "runtime" });
    }
  }
  if (source === "persistence") {
    // Best-effort persistence still wakes readers; observer failures cannot undo it.
    notifyListeners(listeners.persistence, event);
  }
}
