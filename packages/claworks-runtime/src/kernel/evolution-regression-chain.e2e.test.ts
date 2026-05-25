/**
 * weak_model_regression_suite E2E — evolution.regression_requested → PlaybookEngine
 * → action steps routed via capabilities.invoke (step-executor capability routing).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../planes/data/db.js";
import { createKnowledgeBase } from "../planes/data/knowledge-base.js";
import { createObjectStore } from "../planes/data/object-store.js";
import { createHitlGate } from "../planes/orch/hitl-gate.js";
import { createPlaybookEngine } from "../planes/orch/playbook-engine.js";
import type { PlaybookDefinition } from "../planes/orch/playbook-types.js";
import { createEventKernel } from "./event-kernel.js";
import { CW_EVENTS } from "./event-names.js";
import {
  WEAK_MODEL_REGRESSION_PLAYBOOK_ID,
  wireEvolutionSimulationRegressionChain,
} from "./evolution-regression-chain.js";

const FIXED_SCENARIOS = {
  scenarios: [
    { user_input: "3号生产线温度超标了，赶紧处理", expected_intent: "alarm_report" },
    { user_input: "帮我查一下P-101泵现在的运行状态", expected_intent: "equipment_status" },
    { user_input: "今天的生产日报发了吗", expected_intent: "knowledge_query" },
  ],
};

function intentForText(text: string): Record<string, unknown> {
  if (text.includes("温度") || text.includes("超标")) {
    return { intent: "alarm_report", confidence: 0.92 };
  }
  if (text.includes("泵") || text.includes("运行状态")) {
    return { intent: "equipment_status", confidence: 0.88 };
  }
  if (text.includes("日报")) {
    return { intent: "knowledge_query", confidence: 0.86 };
  }
  return { intent: "unknown", confidence: 0.2 };
}

/** Minimal subset of claworks-packs weak_model_regression_suite (capability action steps). */
const WEAK_MODEL_REGRESSION_MINI: PlaybookDefinition = {
  id: WEAK_MODEL_REGRESSION_PLAYBOOK_ID,
  name: "弱模型意图回归测试 (mini)",
  pack: "test",
  priority: 10,
  trigger: { kind: "event", pattern: CW_EVENTS.EVOLUTION_REGRESSION_REQUESTED },
  steps: [
    {
      kind: "action",
      id: "generate_scenarios",
      actionApiName: "evolve.generate_simulations",
      params: { domain: "industrial", count: 3 },
      output: "scenarios",
    },
    {
      kind: "action",
      id: "test_case_1",
      actionApiName: "perceive.intent",
      params: {
        text: "{{ scenarios.scenarios[0].user_input | default('3号生产线温度超标了，赶紧处理') }}",
      },
      output: "intent_1",
    },
    {
      kind: "action",
      id: "test_case_2",
      actionApiName: "perceive.intent",
      params: {
        text: "{{ scenarios.scenarios[1].user_input | default('帮我查一下P-101泵现在的运行状态') }}",
      },
      output: "intent_2",
    },
  ],
};

async function waitForPlaybookRun(
  engine: ReturnType<typeof createPlaybookEngine>,
  playbookId: string,
  timeoutMs = 5000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runs = await engine.listRuns({ playbookId, limit: 1 });
    const run = runs[0];
    if (run && (run.status === "completed" || run.status === "failed")) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for playbook ${playbookId} run`);
}

describe("weak_model_regression_suite E2E", () => {
  it("runs on evolution.regression_requested and routes action steps via capabilities.invoke", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-regression-e2e-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);

    const invokedCaps: string[] = [];
    const capabilityInvoke = vi.fn(async (capId: string, params: Record<string, unknown>) => {
      invokedCaps.push(capId);
      if (capId === "evolve.generate_simulations") {
        return FIXED_SCENARIOS;
      }
      if (capId === "perceive.intent") {
        return intentForText(String(params.text ?? ""));
      }
      return {};
    });
    const capabilityHas = (id: string) =>
      id === "evolve.generate_simulations" || id === "perceive.intent";

    const playbookEngine = createPlaybookEngine({
      db,
      objectStore: createObjectStore(db),
      kb: createKnowledgeBase(),
      robot: {
        name: "regression-e2e",
        role: "monolith",
        version: "0",
        endpoint: "http://127.0.0.1:18800",
      },
      hitl: createHitlGate(),
      notify: async () => {},
    });
    playbookEngine.setCapabilityInvoke(capabilityInvoke, capabilityHas);

    await playbookEngine.loadFromPacks([
      {
        manifest: {
          id: "test",
          name: "Regression E2E",
          version: "1",
          license: "MIT",
          provides: {
            objectTypes: [],
            playbooks: [WEAK_MODEL_REGRESSION_PLAYBOOK_ID],
            actionTypes: [],
          },
        },
        path: dir,
        objectTypes: [],
        playbooks: [WEAK_MODEL_REGRESSION_MINI],
      },
    ]);

    const kernel = createEventKernel({ playbookEngine, db });
    kernel.matcher.load(playbookEngine.list());
    await kernel.start();

    await kernel.publish(CW_EVENTS.EVOLUTION_REGRESSION_REQUESTED, "e2e-test", {
      reason: "knowledge_gap",
      chained_from: CW_EVENTS.EVOLUTION_SIMULATION_REQUESTED,
    });

    const run = await waitForPlaybookRun(playbookEngine, WEAK_MODEL_REGRESSION_PLAYBOOK_ID);
    const allRuns = await playbookEngine.listRuns({
      playbookId: WEAK_MODEL_REGRESSION_PLAYBOOK_ID,
      limit: 10,
    });

    await kernel.stop();
    close();

    expect(allRuns).toHaveLength(1);
    expect(run.status).toBe("completed");
    expect(invokedCaps).toContain("evolve.generate_simulations");
    expect(invokedCaps.filter((c) => c === "perceive.intent")).toHaveLength(2);

    const stepOutput = (stepId: string) =>
      run.steps.find((s) => s.stepId === stepId)?.output as Record<string, unknown> | undefined;

    expect(stepOutput("test_case_1")?.intent).toBe("alarm_report");
    expect(stepOutput("test_case_2")?.intent).toBe("equipment_status");
  });

  it("wireEvolutionSimulationRegressionChain publishes regression_requested after simulation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-regression-chain-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);

    const playbookEngine = createPlaybookEngine({
      db,
      objectStore: createObjectStore(db),
      kb: createKnowledgeBase(),
      robot: {
        name: "chain-e2e",
        role: "monolith",
        version: "0",
        endpoint: "http://127.0.0.1:18800",
      },
      hitl: createHitlGate(),
    });

    const kernel = createEventKernel({ playbookEngine, db });
    await kernel.start();

    const regressionPayloads: Record<string, unknown>[] = [];
    kernel.bus.subscribe(CW_EVENTS.EVOLUTION_REGRESSION_REQUESTED, async (event) => {
      regressionPayloads.push(event.payload as Record<string, unknown>);
    });

    wireEvolutionSimulationRegressionChain({ kernel, logger: vi.fn() } as never);

    await kernel.publish(CW_EVENTS.EVOLUTION_SIMULATION_REQUESTED, "e2e-test", {
      reason: "knowledge_gap",
      auto: true,
    });

    const start = Date.now();
    while (Date.now() - start < 2000 && regressionPayloads.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await kernel.stop();
    close();

    expect(regressionPayloads).toHaveLength(1);
    expect(regressionPayloads[0]?.chained_from).toBe(CW_EVENTS.EVOLUTION_SIMULATION_REQUESTED);
    expect(regressionPayloads[0]?.reason).toBe("knowledge_gap");
  });
});
