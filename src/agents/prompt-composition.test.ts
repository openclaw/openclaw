import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPromptCompositionScenarios,
  type PromptScenario,
} from "./prompt-composition-scenarios.js";

type ScenarioFixture = Awaited<ReturnType<typeof createPromptCompositionScenarios>>;

function getTurn(scenario: PromptScenario, id: string) {
  const turn = scenario.turns.find((entry) => entry.id === id);
  expect(turn, `${scenario.scenario}:${id}`).toBeDefined();
  return turn!;
}

describe("prompt composition invariants", () => {
  let fixture: ScenarioFixture;

  beforeAll(async () => {
    fixture = await createPromptCompositionScenarios();
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("keeps the system prompt stable after warmup for normal user-turn scenarios", () => {
    for (const scenario of fixture.scenarios) {
      if (scenario.expectedStableSystemAfterTurnIds.length === 0) {
        continue;
      }
      for (const turnId of scenario.expectedStableSystemAfterTurnIds) {
        const current = getTurn(scenario, turnId);
        const index = scenario.turns.findIndex((entry) => entry.id === turnId);
        const previous = scenario.turns[index - 1];
        expect(previous, `${scenario.scenario}:${turnId}:previous`).toBeDefined();
        expect(current.systemPrompt, `${scenario.scenario}:${turnId}`).toBe(previous.systemPrompt);
      }
    }
  });

  it("keeps bootstrap warnings out of the system prompt and preserves the original user prompt prefix", () => {
    const scenario = fixture.scenarios.find((entry) => entry.scenario === "bootstrap-warning");
    expect(scenario).toBeDefined();
    const first = getTurn(scenario!, "t1");
    const deduped = getTurn(scenario!, "t2");
    const always = getTurn(scenario!, "t3");

    expect(first.systemPrompt).not.toContain("[Bootstrap truncation warning]");
    expect(first.bodyPrompt.startsWith("hello")).toBe(true);
    expect(first.bodyPrompt).toContain("[Bootstrap truncation warning]");

    expect(deduped.bodyPrompt).toBe("hello again");
    expect(always.bodyPrompt.startsWith("one more turn")).toBe(true);
    expect(always.bodyPrompt).toContain("[Bootstrap truncation warning]");
  });

  it("documents the intentional global exceptions so future churn is explicit", () => {
    const groupScenario = fixture.scenarios.find((entry) => entry.scenario === "auto-reply-group");
    const maintenanceScenario = fixture.scenarios.find(
      (entry) => entry.scenario === "maintenance-prompts",
    );

    expect(groupScenario?.expectedStableSystemAfterTurnIds).toEqual(["t3"]);
    expect(maintenanceScenario?.expectedStableSystemAfterTurnIds).toEqual([]);
  });
});
