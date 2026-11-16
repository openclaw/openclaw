import type { ToolOutcomeObservation } from "../../tool-outcome-observation.js";

/** Sticky current-turn taint shared by retries and runtime-specific tool owners. */
export function createAgentTurnTaintState(initiallyTainted = false) {
  let tainted = initiallyTainted;
  return {
    observe(observation: ToolOutcomeObservation): void {
      if (!observation.presentationOnly && observation.resultContentSource === "network") {
        tainted = true;
      }
    },
    isTainted: () => tainted,
  };
}
