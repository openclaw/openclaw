// Accepted steers settle with their consuming run's terminal classification.
// The embedded steering backend registers each steered source's observer on the
// run that adopted it; that run's settlement delivers the outcome and clears
// the registration, so a consumed steer can never stay pending after its run.

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/steer-run-outcome");

type SteeredRunOutcomeObserver = (outcome: "completed" | "failed") => void;

const steerRunOutcomeObservers = new Map<string, Set<SteeredRunOutcomeObserver>>();

/**
 * Registers one steered source's terminal observer on its consuming run.
 * Returns the unregister callback for owners that withdraw an accepted steer
 * before the consuming run settles.
 */
export function registerSteeredRunOutcomeObserver(
  runId: string,
  observer: SteeredRunOutcomeObserver,
): () => void {
  let observers = steerRunOutcomeObservers.get(runId);
  if (!observers) {
    observers = new Set();
    steerRunOutcomeObservers.set(runId, observers);
  }
  observers.add(observer);
  return () => {
    if (!observers?.delete(observer)) {
      return;
    }
    if (observers.size === 0 && steerRunOutcomeObservers.get(runId) === observers) {
      steerRunOutcomeObservers.delete(runId);
    }
  };
}

/** Reports whether a consuming run still holds steered source observers. */
export function hasSteeredRunOutcomeObservers(runId: string): boolean {
  return (steerRunOutcomeObservers.get(runId)?.size ?? 0) > 0;
}

/**
 * Fans one consuming run's terminal classification out to its steered sources.
 * Each observer runs at most once; one failure never starves the other sources.
 */
export function settleSteeredRunOutcomeObservers(
  runId: string,
  outcome: "completed" | "failed",
): void {
  const observers = steerRunOutcomeObservers.get(runId);
  if (!observers) {
    return;
  }
  steerRunOutcomeObservers.delete(runId);
  for (const observer of observers) {
    try {
      observer(outcome);
    } catch (error) {
      // Steered settlement is best effort; the consuming run's own observers
      // already ran, so a source callback failure must not break the run tail.
      log.warn(`steered run outcome observer failed for run ${runId}: ${String(error)}`);
    }
  }
}
