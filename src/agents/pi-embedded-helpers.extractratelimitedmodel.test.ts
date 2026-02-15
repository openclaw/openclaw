import { describe, expect, it } from "vitest";
import { extractRateLimitedModel } from "./pi-embedded-helpers.js";

describe("extractRateLimitedModel", () => {
  it("extracts model from Google 429 response with quotaDimensions", () => {
    const googleError = JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
            domain: "googleapis.com",
            metadata: {
              service: "generativelanguage.googleapis.com",
              consumer: "projects/12345",
            },
          },
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                subject: "GenerateContent",
                description: "Rate limit exceeded",
              },
            ],
          },
          {
            quotaDimensions: {
              location: "global",
              model: "gemini-3-flash",
            },
          },
        ],
      },
    });

    expect(extractRateLimitedModel(googleError)).toBe("gemini-3-flash");
  });

  it("extracts model from Google 429 response with HTTP prefix", () => {
    const googleErrorWithPrefix = `429 ${JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted",
        details: [
          {
            quotaDimensions: {
              location: "us-central1",
              model: "gemini-2.5-flash-lite",
            },
          },
        ],
      },
    })}`;

    expect(extractRateLimitedModel(googleErrorWithPrefix)).toBe("gemini-2.5-flash-lite");
  });

  it("extracts model from error.model field", () => {
    const errorWithModelField = JSON.stringify({
      error: {
        code: 429,
        message: "Rate limit exceeded",
        model: "gpt-4o-mini",
      },
    });

    expect(extractRateLimitedModel(errorWithModelField)).toBe("gpt-4o-mini");
  });

  it("extracts model from root model field", () => {
    const errorWithRootModel = JSON.stringify({
      code: 429,
      message: "Rate limit exceeded",
      model: "claude-3-5-sonnet",
    });

    expect(extractRateLimitedModel(errorWithRootModel)).toBe("claude-3-5-sonnet");
  });

  it("returns null for non-JSON error", () => {
    expect(extractRateLimitedModel("Rate limit exceeded")).toBeNull();
  });

  it("returns null for JSON without model info", () => {
    const errorWithoutModel = JSON.stringify({
      error: {
        code: 429,
        message: "Rate limit exceeded",
      },
    });

    expect(extractRateLimitedModel(errorWithoutModel)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractRateLimitedModel("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(extractRateLimitedModel("   ")).toBeNull();
  });

  it("handles multiple details entries, extracting from quotaDimensions", () => {
    const googleErrorMultipleDetails = JSON.stringify({
      error: {
        code: 429,
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo" },
          { someOther: "data" },
          {
            quotaDimensions: {
              location: "global",
              model: "gemini-3-pro-preview",
            },
          },
          { moreData: true },
        ],
      },
    });

    expect(extractRateLimitedModel(googleErrorMultipleDetails)).toBe("gemini-3-pro-preview");
  });

  it("extracts from root-level details (without error wrapper)", () => {
    const rootLevelDetails = JSON.stringify({
      code: 429,
      details: [
        {
          quotaDimensions: {
            model: "gemini-exp-1206",
          },
        },
      ],
    });

    expect(extractRateLimitedModel(rootLevelDetails)).toBe("gemini-exp-1206");
  });
});
