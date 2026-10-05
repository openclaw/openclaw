import { describe, expect, it } from "vitest";
import { isConsentQuestionUtterance, REALTIME_VOICE_CONSENT_QUESTION } from "./realtime-consent.js";

describe("isConsentQuestionUtterance", () => {
  it("accepts the canonical consent question verbatim", () => {
    expect(isConsentQuestionUtterance(REALTIME_VOICE_CONSENT_QUESTION)).toBe(true);
  });

  it("accepts a question-shaped paraphrase on both topics", () => {
    expect(
      isConsentQuestionUtterance("Would you consent to this conversation being recorded?"),
    ).toBe(true);
    expect(isConsentQuestionUtterance("Do you consent to recording this conversation")).toBe(true);
  });

  it("rejects a statement that only names consent and recording", () => {
    expect(isConsentQuestionUtterance("We require consent for recording.")).toBe(false);
    expect(isConsentQuestionUtterance("Recording is enabled with your consent.")).toBe(false);
  });

  it("rejects questions on only one topic or none", () => {
    expect(isConsentQuestionUtterance("Do you consent to these terms?")).toBe(false);
    expect(isConsentQuestionUtterance("Can I record this for you?")).toBe(false);
    expect(isConsentQuestionUtterance("Hello, how can I help you today?")).toBe(false);
  });

  it("rejects empty turns", () => {
    expect(isConsentQuestionUtterance("")).toBe(false);
    expect(isConsentQuestionUtterance("   ")).toBe(false);
  });
});
