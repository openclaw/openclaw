import { describe, expect, it } from "vitest";
import { renderUserFacingText } from "../embedded-agent-helpers/user-facing-text.js";
import {
  renderRateLimitOrOverloadedCopy,
  renderRateLimitResetCopy,
  renderRateLimitRetryExhaustion,
  renderSanitizedUserFacingText,
} from "./user-copy.js";

describe("localized provider failures", () => {
  it.each([
    ["ECONNRESET", "Die Verbindung zum KI-Dienst wurde unterbrochen"],
    ["ENOTFOUND", "Die Verbindung zum KI-Dienst ist fehlgeschlagen"],
    ["socket hang up", "Die Verbindung zum KI-Dienst wurde unterbrochen"],
    ["request timed out", "Die Anfrage hat zu lange gedauert"],
    [
      "An error occurred while processing your request. Contact help.openai.com.",
      "The AI service returned an internal error",
    ],
  ])("preserves the failure cause when rendering German %s", (raw, expected) => {
    expect(renderUserFacingText(raw, { errorContext: true, locale: "de" })).toContain(expected);
  });

  it("uses a singular German retry instruction for one recorded attempt", () => {
    expect(renderRateLimitRetryExhaustion(1, false, "de")).toContain(
      "einem automatischen Wiederholungsversuch",
    );
  });
  it("localizes the synthesized timeout only at presentation and preserves ordinary text", () => {
    const text = "LLM request timed out.";
    expect(renderSanitizedUserFacingText(text, { errorContext: true, locale: "de" })).toContain(
      "Die Anfrage hat zu lange gedauert",
    );
    expect(renderSanitizedUserFacingText(text, { errorContext: true, locale: "en" })).toBe(text);
    expect(renderSanitizedUserFacingText(text, { locale: "de" })).toBe(text);
  });
  it("renders German overload copy without changing the English fallback", () => {
    expect(renderRateLimitOrOverloadedCopy({ reason: "overloaded", locale: "de-DE" })).toBe(
      "Der KI-Dienst ist vorübergehend überlastet. Bitte versuche es gleich noch einmal.",
    );
    expect(renderRateLimitOrOverloadedCopy({ reason: "overloaded", locale: "fr" })).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
  });

  it("uses the same language for reset guidance and the provider deadline", () => {
    const text = renderRateLimitResetCopy({
      locale: "de",
      timeZone: "UTC",
      provider: "example",
      model: "test",
      nowMs: Date.UTC(2026, 0, 1),
      rateLimitResetAt: Date.UTC(2026, 0, 1, 2),
    });
    expect(text).toContain("example/test");
    expect(text).toContain("in 2 Stunden");
    expect(text).toContain("Laut Anbieter");
    expect(text).not.toContain("The provider says");
  });
});
