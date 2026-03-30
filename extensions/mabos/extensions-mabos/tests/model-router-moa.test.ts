import { describe, it, expect } from "vitest";
import {
  calculateAgreementScore,
  buildReferencePrompt,
  buildAggregatorPrompt,
} from "../src/model-router/moa.js";

describe("Mixture-of-Agents helpers", () => {
  it("calculates high agreement score for identical responses", () => {
    const responses = [
      "The answer to this complex problem is forty-two because of the underlying mathematical structure",
      "The answer to this complex problem is forty-two because of the underlying mathematical structure",
    ];
    const score = calculateAgreementScore(responses);
    expect(score).toBeGreaterThan(0.8);
  });

  it("calculates low agreement for diverse responses", () => {
    const responses = [
      "Quantum mechanics governs subatomic particle behavior through wave functions",
      "Renaissance painting techniques evolved from tempera toward oils during the fifteenth century",
      "Distributed database systems achieve consistency through consensus protocols like Raft",
    ];
    const score = calculateAgreementScore(responses);
    expect(score).toBeLessThan(0.5);
  });

  it("builds reference prompt with problem context", () => {
    const prompt = buildReferencePrompt("What is 2+2?");
    expect(prompt).toContain("What is 2+2?");
    expect(prompt).toContain("expert models");
    expect(prompt).toContain("Problem:");
  });

  it("builds aggregator prompt with all reference responses", () => {
    const refs = [
      { model: "gpt-4", response: "The answer is 4" },
      { model: "claude", response: "Two plus two equals four" },
    ];
    const prompt = buildAggregatorPrompt("What is 2+2?", refs);
    expect(prompt).toContain("What is 2+2?");
    expect(prompt).toContain("gpt-4");
    expect(prompt).toContain("claude");
    expect(prompt).toContain("The answer is 4");
    expect(prompt).toContain("Two plus two equals four");
    expect(prompt).toContain("Synthesize");
  });
});
