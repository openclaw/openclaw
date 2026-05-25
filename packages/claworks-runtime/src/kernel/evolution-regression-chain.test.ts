import { describe, expect, it, vi } from "vitest";
import { CW_EVENTS } from "./event-names.js";
import {
  WEAK_MODEL_REGRESSION_PLAYBOOK_ID,
  wireEvolutionRegressionPlaybookTrigger,
  wireEvolutionSimulationRegressionChain,
} from "./evolution-regression-chain.js";

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

describe("wireEvolutionRegressionPlaybookTrigger", () => {
  it("triggers weak_model_regression_suite when playbook is loaded", async () => {
    let regressionHandler:
      | ((event: {
          id: string;
          type: string;
          source: string;
          payload: Record<string, unknown>;
        }) => Promise<void>)
      | undefined;
    const trigger = vi.fn().mockResolvedValue({ id: "run-1", status: "completed" });

    const runtime = {
      playbookEngine: {
        list: vi.fn(() => [{ id: WEAK_MODEL_REGRESSION_PLAYBOOK_ID }]),
        trigger,
      },
      kernel: {
        bus: {
          subscribe: vi.fn((type: string, handler: typeof regressionHandler) => {
            if (type === CW_EVENTS.EVOLUTION_REGRESSION_REQUESTED) {
              regressionHandler = handler;
            }
            return () => undefined;
          }),
        },
      },
      logger: vi.fn(),
    };

    wireEvolutionRegressionPlaybookTrigger(runtime as never);
    expect(regressionHandler).toBeDefined();

    await regressionHandler!({
      id: "evt-2",
      type: CW_EVENTS.EVOLUTION_REGRESSION_REQUESTED,
      source: "test",
      payload: { chained_from: "evolution.simulation_requested" },
    });

    expect(trigger).toHaveBeenCalledWith(
      WEAK_MODEL_REGRESSION_PLAYBOOK_ID,
      expect.objectContaining({ chained_from: "evolution.simulation_requested" }),
      expect.objectContaining({ triggerEvent: expect.objectContaining({ id: "evt-2" }) }),
    );
  });

  it("skips when regression suite playbook is not loaded", async () => {
    let regressionHandler:
      | ((event: { payload: Record<string, unknown> }) => Promise<void>)
      | undefined;
    const trigger = vi.fn();

    const runtime = {
      playbookEngine: { list: vi.fn(() => []), trigger },
      kernel: {
        bus: {
          subscribe: vi.fn((_type: string, handler: typeof regressionHandler) => {
            regressionHandler = handler;
            return () => undefined;
          }),
        },
      },
      logger: vi.fn(),
    };

    wireEvolutionRegressionPlaybookTrigger(runtime as never);
    await regressionHandler!({ payload: {} });
    expect(trigger).not.toHaveBeenCalled();
  });
});
