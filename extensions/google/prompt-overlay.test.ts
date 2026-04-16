import { describe, expect, it } from "vitest";
import {
  GOOGLE_GEMINI_EXECUTION_GUIDANCE,
  resolveGoogleSystemPromptContribution,
} from "./prompt-overlay.js";

describe("resolveGoogleSystemPromptContribution", () => {
  it("returns tool_enforcement sectionOverrides for Google provider with Gemini model", () => {
    const result = resolveGoogleSystemPromptContribution({
      modelProviderId: "google",
      modelId: "gemini-3.1-pro-preview",
    });
    expect(result).toEqual({
      sectionOverrides: {
        tool_enforcement: GOOGLE_GEMINI_EXECUTION_GUIDANCE,
      },
    });
  });

  it("returns tool_enforcement sectionOverrides for google-gemini-cli provider", () => {
    const result = resolveGoogleSystemPromptContribution({
      modelProviderId: "google-gemini-cli",
      modelId: "gemini-3-flash-preview",
    });
    expect(result).toEqual({
      sectionOverrides: {
        tool_enforcement: GOOGLE_GEMINI_EXECUTION_GUIDANCE,
      },
    });
  });

  it("returns undefined for non-Google providers", () => {
    expect(
      resolveGoogleSystemPromptContribution({
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      }),
    ).toBeUndefined();

    expect(
      resolveGoogleSystemPromptContribution({
        modelProviderId: "openai",
        modelId: "gpt-5",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when modelProviderId is undefined", () => {
    expect(
      resolveGoogleSystemPromptContribution({
        modelProviderId: undefined,
        modelId: "gemini-3.1-pro-preview",
      }),
    ).toBeUndefined();
  });
});
