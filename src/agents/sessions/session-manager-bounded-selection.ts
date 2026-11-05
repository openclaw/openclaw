import type { SessionTranscriptBoundedActiveContext } from "../../config/sessions/session-accessor.sqlite-contract.js";

export type SessionManagerBoundedSelection = {
  /** Selected active-context rows; excludes the session header and injected boundary events. */
  selectedEvents: number;
  /** More active-context rows remain outside this bounded read. */
  truncated: boolean;
};

// Internal progress facts for bounded readers; kept off the public SessionManager shape.
const selections = new WeakMap<object, SessionManagerBoundedSelection>();

export function recordSessionManagerBoundedSelection(
  manager: object,
  context: Pick<SessionTranscriptBoundedActiveContext, "selectedEventCount" | "truncated">,
): void {
  selections.set(manager, {
    selectedEvents: context.selectedEventCount,
    truncated: context.truncated,
  });
}

export function readSessionManagerBoundedSelection(
  manager: object,
): SessionManagerBoundedSelection | undefined {
  return selections.get(manager);
}
