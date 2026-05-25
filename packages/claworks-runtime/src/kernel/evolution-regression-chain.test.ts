import { describe, expect, it, vi } from "vitest";
import { CW_EVENTS } from "./event-names.js";
import { wireEvolutionSimulationRegressionChain } from "./evolution-regression-chain.js";

describe("wireEvolutionSimulationRegressionChain", () => {
  it("publishes evolution.regression_requested when simulation_requested fires", async () => {
    const published: Array<{ type: string; source: string; payload: Record<string, unknown> }> = [];
    let simulationHandler:
      | ((event: { id: string; payload: Record<string, unknown> }) => Promise<void>)
      | undefined;

    const runtime = {
      kernel: {
        bus: {
          subscribe: vi.fn((type: string, handler: typeof simulationHandler) => {
            if (type === CW_EVENTS.EVOLUTION_SIMULATION_REQUESTED) {
              simulationHandler = handler;
            }
            return () => undefined;
          }),
        },
        publish: vi.fn(async (type: string, source: string, payload: Record<string, unknown>) => {
          published.push({ type, source, payload });
        }),
      },
    };

    wireEvolutionSimulationRegressionChain(runtime as never);
    expect(simulationHandler).toBeDefined();

    await simulationHandler!({
      id: "evt-1",
      payload: { reason: "knowledge_gap", auto: true },
    });

    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({
      type: CW_EVENTS.EVOLUTION_REGRESSION_REQUESTED,
      source: "evolution-regression-chain",
      payload: {
        reason: "knowledge_gap",
        auto: true,
        chained_from: CW_EVENTS.EVOLUTION_SIMULATION_REQUESTED,
        source_event_id: "evt-1",
      },
    });
  });
});
