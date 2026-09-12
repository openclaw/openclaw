import type { MatrixQaObservedEvent } from "../substrate/events.js";

export function createCurrentScenarioEventPredicate(
  observedEvents: readonly MatrixQaObservedEvent[],
  startObservedIndex: number,
) {
  const preexistingEventIds = new Set(
    observedEvents.slice(0, startObservedIndex).map((event) => event.eventId),
  );
  return (event: MatrixQaObservedEvent) => !preexistingEventIds.has(event.eventId);
}
