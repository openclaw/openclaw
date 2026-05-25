/**
 * Chains evolution.simulation_requested → evolution.regression_requested
 * and triggers weak_model_regression_suite when regression is requested.
 */
import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import { CW_EVENTS } from "./event-names.js";

export const WEAK_MODEL_REGRESSION_PLAYBOOK_ID = "weak_model_regression_suite";

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

/** Trigger weak_model_regression_suite Playbook on evolution.regression_requested. */
export function wireEvolutionRegressionPlaybookTrigger(runtime: ClaworksRuntime): () => void {
  return runtime.kernel.bus.subscribe(CW_EVENTS.EVOLUTION_REGRESSION_REQUESTED, async (event) => {
    const playbooks = runtime.playbookEngine.list();
    const loaded = playbooks.some((p) => p.id === WEAK_MODEL_REGRESSION_PLAYBOOK_ID);
    if (!loaded) {
      runtime.logger?.(
        `[claworks:regression] ${WEAK_MODEL_REGRESSION_PLAYBOOK_ID} not loaded — skip auto trigger`,
      );
      return;
    }

    const payload =
      typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
        ? event.payload
        : {};

    runtime.logger?.(
      `[claworks:regression] triggering ${WEAK_MODEL_REGRESSION_PLAYBOOK_ID} (chained_from=${String(payload.chained_from ?? "?")})`,
    );

    try {
      await runtime.playbookEngine.trigger(WEAK_MODEL_REGRESSION_PLAYBOOK_ID, payload, {
        triggerEvent: {
          id: event.id,
          type: event.type,
          source: event.source,
          timestamp: new Date(),
          payload,
          traceparent: event.traceparent,
          traceId: event.traceId,
        },
      });
    } catch (err) {
      runtime.logger?.(
        `[claworks:regression] trigger failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
