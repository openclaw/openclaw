/**
 * Chains evolution.simulation_requested → evolution.regression_requested
 * so weak_model_regression_suite runs after simulation/distillation triggers.
 */
import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import { CW_EVENTS } from "./event-names.js";

export function wireEvolutionSimulationRegressionChain(runtime: ClaworksRuntime): () => void {
  return runtime.kernel.bus.subscribe(CW_EVENTS.EVOLUTION_SIMULATION_REQUESTED, async (event) => {
    const payload =
      typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
        ? event.payload
        : {};
    await runtime.kernel.publish(
      CW_EVENTS.EVOLUTION_REGRESSION_REQUESTED,
      "evolution-regression-chain",
      {
        ...payload,
        chained_from: CW_EVENTS.EVOLUTION_SIMULATION_REQUESTED,
        source_event_id: event.id,
      },
    );
  });
}
