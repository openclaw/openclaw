import { describe, expect, it } from "vitest";

/**
 * Tests for the suppressPreToolText feature.
 *
 * The feature splices intermediate assistant texts (e.g. "Lass mich nachschauen...")
 * produced during tool-use turns, keeping only the final answer turn.
 *
 * Implementation lives in finalizeAssistantTexts() which is a closure inside
 * subscribeEmbeddedPiSession(). We can't call it directly, so we test the
 * splice logic in isolation.
 */
describe("suppressPreToolText splice logic", () => {
  /**
   * Simulates the splice behavior from finalizeAssistantTexts:
   * When stopReason is "toolUse" and suppressPreToolText is enabled (and not verbose),
   * remove texts added since baseline.
   */
  function simulateFinalizeWithSplice(params: {
    assistantTexts: string[];
    baseline: number;
    stopReason?: string;
    suppressPreToolText: boolean;
    verboseLevel: "off" | "on" | "full";
  }): { assistantTexts: string[]; newBaseline: number } {
    const texts = [...params.assistantTexts];
    const isVerbose = params.verboseLevel !== "off";

    if (params.stopReason === "toolUse" && params.suppressPreToolText && !isVerbose) {
      texts.splice(params.baseline);
    }

    return { assistantTexts: texts, newBaseline: texts.length };
  }

  it('splices texts since baseline when stopReason="toolUse" + suppressPreToolText=true', () => {
    const result = simulateFinalizeWithSplice({
      assistantTexts: ["previous answer", "Lass mich nachschauen..."],
      baseline: 1, // "Lass mich nachschauen..." was added since baseline
      stopReason: "toolUse",
      suppressPreToolText: true,
      verboseLevel: "off",
    });

    expect(result.assistantTexts).toEqual(["previous answer"]);
  });

  it('does NOT splice when stopReason="stop" (final answer preserved)', () => {
    const result = simulateFinalizeWithSplice({
      assistantTexts: ["previous answer", "Here is the final answer"],
      baseline: 1,
      stopReason: "stop",
      suppressPreToolText: true,
      verboseLevel: "off",
    });

    expect(result.assistantTexts).toEqual(["previous answer", "Here is the final answer"]);
  });

  it('does NOT splice when verbose="on" (debug mode)', () => {
    const result = simulateFinalizeWithSplice({
      assistantTexts: ["Lass mich nachschauen..."],
      baseline: 0,
      stopReason: "toolUse",
      suppressPreToolText: true,
      verboseLevel: "on",
    });

    expect(result.assistantTexts).toEqual(["Lass mich nachschauen..."]);
  });

  it('does NOT splice when verbose="full" (debug mode)', () => {
    const result = simulateFinalizeWithSplice({
      assistantTexts: ["Lass mich nachschauen..."],
      baseline: 0,
      stopReason: "toolUse",
      suppressPreToolText: true,
      verboseLevel: "full",
    });

    expect(result.assistantTexts).toEqual(["Lass mich nachschauen..."]);
  });

  it("does NOT splice when suppressPreToolText=false (feature disabled)", () => {
    const result = simulateFinalizeWithSplice({
      assistantTexts: ["Lass mich nachschauen..."],
      baseline: 0,
      stopReason: "toolUse",
      suppressPreToolText: false,
      verboseLevel: "off",
    });

    expect(result.assistantTexts).toEqual(["Lass mich nachschauen..."]);
  });

  it("multi-turn: intermediate tool-use texts removed, final turn texts preserved", () => {
    // Simulate a multi-turn conversation:
    // Turn 1: agent says "Let me check..." then uses a tool → splice at baseline=0
    const turn1 = simulateFinalizeWithSplice({
      assistantTexts: ["Let me check..."],
      baseline: 0,
      stopReason: "toolUse",
      suppressPreToolText: true,
      verboseLevel: "off",
    });
    expect(turn1.assistantTexts).toEqual([]);
    expect(turn1.newBaseline).toBe(0);

    // Turn 2: agent says "Based on the results, here is your answer" → stop
    const turn2Texts = [...turn1.assistantTexts, "Based on the results, here is your answer"];
    const turn2 = simulateFinalizeWithSplice({
      assistantTexts: turn2Texts,
      baseline: turn1.newBaseline,
      stopReason: "stop",
      suppressPreToolText: true,
      verboseLevel: "off",
    });
    expect(turn2.assistantTexts).toEqual(["Based on the results, here is your answer"]);
  });
});
