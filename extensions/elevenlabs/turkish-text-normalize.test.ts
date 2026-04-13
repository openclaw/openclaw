import { describe, expect, it } from "vitest";
import { normalizeTurkishForTts } from "./turkish-text-normalize.js";

describe("normalizeTurkishForTts", () => {
  it("replaces circumflex vowels", () => {
    expect(normalizeTurkishForTts("Bismillâhirrahmânirrahîm")).toBe(
      "Bismillahirrahmanirrahim",
    );
  });

  it("handles uppercase circumflex", () => {
    expect(normalizeTurkishForTts("ÂLEM")).toBe("ALEM");
  });

  it("preserves standard Turkish characters", () => {
    expect(normalizeTurkishForTts("çığırtkan öğüşme şüpheli")).toBe(
      "çığırtkan öğüşme şüpheli",
    );
  });

  it("preserves text without circumflex", () => {
    const text = "Merhaba, nasılsınız?";
    expect(normalizeTurkishForTts(text)).toBe(text);
  });

  it("handles empty string", () => {
    expect(normalizeTurkishForTts("")).toBe("");
  });

  it("handles mixed content", () => {
    expect(normalizeTurkishForTts("İmâm-ı Rabbânî hazretleri")).toBe(
      "İmam-ı Rabbani hazretleri",
    );
  });
});
