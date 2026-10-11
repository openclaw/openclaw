// Verifies prompt composition invariants across generated agent scenarios.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPromptCompositionScenarios,
  type PromptScenario,
} from "../../test/helpers/agents/prompt-composition-scenarios.js";

type ScenarioFixture = Awaited<ReturnType<typeof createPromptCompositionScenarios>>;

function getTurn(scenario: PromptScenario, id: string) {
  // Scenario assertions use named turns so failures identify the prompt boundary.
  const turn = scenario.turns.find((entry) => entry.id === id);
  if (!turn) {
    throw new Error(`expected turn ${scenario.scenario}:${id}`);
  }
  return turn;
}

function getScenario(fixture: ScenarioFixture, id: string): PromptScenario {
  const scenario = fixture.scenarios.find((entry) => entry.scenario === id);
  if (!scenario) {
    throw new Error(`expected prompt scenario ${id}`);
  }
  return scenario;
}

function countOccurrences(text: string, needle: string): number {
  // Avoid regex escaping when checking exact prompt-body duplication.
  if (!needle) {
    return 0;
  }
  return text.split(needle).length - 1;
}

describe("prompt composition invariants", () => {
  let fixture: ScenarioFixture;

  beforeAll(async () => {
    fixture = await createPromptCompositionScenarios();
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("keeps the bootstrap truncation notice in the system prompt and body prompts untouched", () => {
    const scenario = getScenario(fixture, "bootstrap-warning");
    const first = getTurn(scenario, "t1");
    const second = getTurn(scenario, "t2");
    const third = getTurn(scenario, "t3");

    expect(first.systemPrompt).toContain("## Bootstrap Context Notice");
    expect(first.systemPrompt).toContain("[Bootstrap truncation warning]");
    expect(first.systemPrompt).toContain("[...truncated, read AGENTS.md for full content...]");
    for (const turn of [first, second, third]) {
      expect(turn.bodyPrompt).not.toContain("[Bootstrap truncation warning]");
    }
    expect(first.bodyPrompt).toBe("hello");
    expect(second.bodyPrompt).toBe("hello again");
    expect(third.bodyPrompt).toBe("one more turn");
  });

  it("keeps Discord supplemental context out of the inbound body text", () => {
    const scenario = getScenario(fixture, "auto-reply-discord-boundary");
    const turn = getTurn(scenario, "t1");
    const inboundBody = "Please summarize the deploy log.";

    expect(turn.bodyPrompt).toContain("Discord channel metadata: ⟦openclaw:ctx⟧");
    expect(turn.bodyPrompt).toContain('"topic":"Deploy coordination"');
    expect(turn.bodyPrompt).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(countOccurrences(turn.bodyPrompt, inboundBody)).toBe(1);
    expect(turn.systemPrompt).not.toContain(inboundBody);
  });
});
