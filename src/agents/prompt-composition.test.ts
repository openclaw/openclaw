// Verifies bootstrap notices and Discord prompt composition boundaries.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPromptCompositionScenarios } from "../../test/helpers/agents/prompt-composition-scenarios.js";

type ScenarioFixture = Awaited<ReturnType<typeof createPromptCompositionScenarios>>;

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

  it("keeps the bootstrap truncation notice in the system prompt", () => {
    const systemPrompt = fixture.bootstrapWarningSystemPrompt;

    expect(systemPrompt).toContain("## Bootstrap Context Notice");
    expect(systemPrompt).toContain("[Bootstrap truncation warning]");
    expect(systemPrompt).toContain("[...truncated, read AGENTS.md for full content...]");
  });

  it("keeps Discord supplemental context out of the inbound body text", () => {
    const turn = fixture.discordBoundary;
    const inboundBody = "Please summarize the deploy log.";

    expect(turn.bodyPrompt).toContain("Discord channel metadata: ⟦openclaw:ctx⟧");
    expect(turn.bodyPrompt).toContain('"topic":"Deploy coordination"');
    expect(turn.bodyPrompt).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(countOccurrences(turn.bodyPrompt, inboundBody)).toBe(1);
    expect(turn.systemPrompt).not.toContain(inboundBody);
  });
});
