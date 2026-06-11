import { describe, expect, it } from "vitest";
import { isVerbalInterrupt } from "./verbal-interrupt.js";

describe("isVerbalInterrupt", () => {
  it("matches interrupt utterances, with punctuation and filler", () => {
    for (const text of [
      "stop",
      "Stop!",
      "ok stop",
      "Stop, please.",
      "no wait",
      "hold on",
      "Hang on...",
      "Never mind.",
      "wait wait",
      "shut up",
      "that's enough",
    ]) {
      expect(isVerbalInterrupt(text), text).toBe(true);
    }
  });

  it("strips configured wake phrases so '⟨name⟩, stop' cuts like a bare 'stop'", () => {
    const wake = ["aria", "open claw"];
    for (const text of [
      "Aria, stop",
      "hey aria stop",
      "stop aria",
      "ok Aria, please stop",
      "Open Claw, hold on",
    ]) {
      expect(isVerbalInterrupt(text, wake), text).toBe(true);
    }
    // The wake word alone is an address, not an interrupt; longer requests still don't match.
    expect(isVerbalInterrupt("Aria?", wake)).toBe(false);
    expect(isVerbalInterrupt("aria stop the server", wake)).toBe(false);
    // Without configured wake phrases, "aria stop" is not a whole-utterance interrupt.
    expect(isVerbalInterrupt("aria stop")).toBe(false);
  });

  it("does not match sentences that merely contain an interrupt word", () => {
    for (const text of [
      "stop by the store on your way",
      "can you stop the server",
      "wait for the report to finish first",
      "I can't wait to see it",
      "tell me when the pause ends in the song",
      "",
      undefined,
    ]) {
      expect(isVerbalInterrupt(text), String(text)).toBe(false);
    }
  });
});
