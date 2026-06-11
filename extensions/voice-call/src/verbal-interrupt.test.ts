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
