import { describe, expect, it } from "vitest";
import { shouldUseImagePreAnalysis } from "./image-pre-analysis.js";

describe("shouldUseImagePreAnalysis", () => {
  it("returns true when imageModel.primary is configured", () => {
    const result = shouldUseImagePreAnalysis({
      config: {
        agents: {
          defaults: {
            imageModel: {
              primary: "gemini-crs/gemini-3-flash-preview",
            },
          },
        },
      },
    });

    expect(result).toBe(true);
  });

  it("returns true when imageModel.fallbacks is configured", () => {
    const result = shouldUseImagePreAnalysis({
      config: {
        agents: {
          defaults: {
            imageModel: {
              fallbacks: ["openai/gpt-4o", "anthropic/claude-3-sonnet"],
            },
          },
        },
      },
    });

    expect(result).toBe(true);
  });

  it("returns true when both primary and fallbacks are configured", () => {
    const result = shouldUseImagePreAnalysis({
      config: {
        agents: {
          defaults: {
            imageModel: {
              primary: "gemini-crs/gemini-3-flash-preview",
              fallbacks: ["openai/gpt-4o"],
            },
          },
        },
      },
    });

    expect(result).toBe(true);
  });

  it("returns false when imageModel is not configured", () => {
    const result = shouldUseImagePreAnalysis({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-3-opus",
            },
          },
        },
      },
    });

    expect(result).toBe(false);
  });

  it("returns false when imageModel is empty object", () => {
    const result = shouldUseImagePreAnalysis({
      config: {
        agents: {
          defaults: {
            imageModel: {},
          },
        },
      },
    });

    expect(result).toBe(false);
  });

  it("returns false when imageModel.primary is empty string", () => {
    const result = shouldUseImagePreAnalysis({
      config: {
        agents: {
          defaults: {
            imageModel: {
              primary: "   ",
            },
          },
        },
      },
    });

    expect(result).toBe(false);
  });

  it("returns false when imageModel.fallbacks is empty array", () => {
    const result = shouldUseImagePreAnalysis({
      config: {
        agents: {
          defaults: {
            imageModel: {
              fallbacks: [],
            },
          },
        },
      },
    });

    expect(result).toBe(false);
  });

  it("returns false when config is undefined", () => {
    const result = shouldUseImagePreAnalysis({
      config: undefined,
    });

    expect(result).toBe(false);
  });

  it("returns false when agents.defaults is undefined", () => {
    const result = shouldUseImagePreAnalysis({
      config: {
        agents: {},
      },
    });

    expect(result).toBe(false);
  });

  it("ignores modelSupportsImages parameter (kept for compatibility)", () => {
    // Even if main model supports images, should still return true when imageModel is configured
    const result = shouldUseImagePreAnalysis({
      config: {
        agents: {
          defaults: {
            imageModel: {
              primary: "gemini-crs/gemini-3-flash-preview",
            },
          },
        },
      },
      modelSupportsImages: true,
    });

    expect(result).toBe(true);
  });
});
