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

  it("matches Arabic interrupts — bilingual #19, the cut must work in both call languages", () => {
    for (const text of [
      "توقف", // stop
      "تَوَقَّف!", // stop, with tashkeel + punctuation
      "خلاص", // enough
      "اسكت", // be quiet
      "لحظة", // one moment
      "انتظر لحظة", // wait a moment
      "طيب توقف", // "ok stop" (Arabic filler)
      "لا انتظر", // "no wait"
    ]) {
      expect(isVerbalInterrupt(text), text).toBe(true);
    }
  });

  it("strips Arabic wake phrases and rejects longer Arabic sentences", () => {
    const wake = ["مساعد"];
    // "يا مساعد توقف" = "hey assistant, stop" — the vocative + wake phrase strip away.
    expect(isVerbalInterrupt("يا مساعد توقف", wake)).toBe(true);
    // The wake word alone is an address, not an interrupt.
    expect(isVerbalInterrupt("مساعد", wake)).toBe(false);
    // "stop by the store on your way" (Arabic) — a sentence containing توقف must not cut.
    expect(isVerbalInterrupt("توقف عند المتجر في طريقك")).toBe(false);
  });
});
