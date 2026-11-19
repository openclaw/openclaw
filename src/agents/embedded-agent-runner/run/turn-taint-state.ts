import type { AdmittedRunContext } from "../../admitted-run-context.js";
import type { ToolOutcomeObservation } from "../../tool-outcome-observation.js";

/** Sticky current-turn taint shared by retries and runtime-specific tool owners. */
export function createAgentTurnTaintState(initiallyTainted = false) {
  let tainted = initiallyTainted;
  return {
    observe(this: void, observation: ToolOutcomeObservation): void {
      if (!observation.presentationOnly && observation.resultContentSource === "network") {
        tainted = true;
      }
    },
    isTainted: () => tainted,
  };
}

// The host admission, not a session id or child-supplied field, owns CLI taint.
// Warm-process grants rotate admissions; retries retain the same sticky state.
const admittedTurnTaints = new WeakMap<
  AdmittedRunContext,
  ReturnType<typeof createAgentTurnTaintState>
>();

export function getAdmittedRunTurnTaintState(context: AdmittedRunContext | undefined) {
  if (!context) {
    return undefined;
  }
  let state = admittedTurnTaints.get(context);
  if (!state) {
    state = createAgentTurnTaintState();
    admittedTurnTaints.set(context, state);
  }
  return state;
}
