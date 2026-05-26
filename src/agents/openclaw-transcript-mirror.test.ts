import { describe, expect, it } from "vitest";
import {
  isTranscriptOnlyOpenclawAssistant,
  TRANSCRIPT_ONLY_OPENCLAW_MODELS,
} from "./openclaw-transcript-mirror.js";

describe("isTranscriptOnlyOpenclawAssistant", () => {
  it("returns true for the channel-delivery mirror assistant turn", () => {
    expect(
      isTranscriptOnlyOpenclawAssistant({
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    ).toBe(true);
  });

  it("returns true for the gateway-injected assistant turn", () => {
    expect(
      isTranscriptOnlyOpenclawAssistant({
        role: "assistant",
        provider: "openclaw",
        model: "gateway-injected",
      }),
    ).toBe(true);
  });

  it("returns false for a real assistant turn from any provider", () => {
    expect(
      isTranscriptOnlyOpenclawAssistant({
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    ).toBe(false);
    expect(
      isTranscriptOnlyOpenclawAssistant({
        role: "assistant",
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).toBe(false);
  });

  it("returns false when provider is openclaw but the model is not a transcript-only marker", () => {
    expect(
      isTranscriptOnlyOpenclawAssistant({
        role: "assistant",
        provider: "openclaw",
        model: "best-effort-summary",
      }),
    ).toBe(false);
    expect(
      isTranscriptOnlyOpenclawAssistant({
        role: "assistant",
        provider: "openclaw",
        model: undefined,
      }),
    ).toBe(false);
  });

  it("returns false for non-assistant roles even with the transcript-only model", () => {
    expect(
      isTranscriptOnlyOpenclawAssistant({
        role: "user",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    ).toBe(false);
    expect(
      isTranscriptOnlyOpenclawAssistant({
        role: "tool",
        provider: "openclaw",
        model: "gateway-injected",
      }),
    ).toBe(false);
  });

  it("returns false for null/undefined/non-object inputs", () => {
    expect(isTranscriptOnlyOpenclawAssistant(null)).toBe(false);
    expect(isTranscriptOnlyOpenclawAssistant(undefined)).toBe(false);
    expect(isTranscriptOnlyOpenclawAssistant("delivery-mirror")).toBe(false);
    expect(isTranscriptOnlyOpenclawAssistant(42)).toBe(false);
  });

  it("returns false when provider field is missing", () => {
    expect(
      isTranscriptOnlyOpenclawAssistant({
        role: "assistant",
        model: "delivery-mirror",
      }),
    ).toBe(false);
  });

  it("exposes the canonical model identifier set for callers that need both names", () => {
    expect(TRANSCRIPT_ONLY_OPENCLAW_MODELS.has("delivery-mirror")).toBe(true);
    expect(TRANSCRIPT_ONLY_OPENCLAW_MODELS.has("gateway-injected")).toBe(true);
    expect(TRANSCRIPT_ONLY_OPENCLAW_MODELS.size).toBe(2);
  });
});
