import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldUpdateSummary, generateSummary, __testing } from "./summary.js";

const {
  buildInitialSummaryPrompt,
  buildUpdateSummaryPrompt,
  formatTurnsForSummary,
  filterMeaningfulTurns,
} = __testing;

// Mock the guardian-client module
vi.mock("./guardian-client.js", () => ({
  callForText: vi.fn(),
}));

import { callForText } from "./guardian-client.js";

describe("summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("shouldUpdateSummary", () => {
    it("returns false when total turns <= maxRecentTurns", () => {
      expect(shouldUpdateSummary(2, 3, false, 0)).toBe(false);
      expect(shouldUpdateSummary(3, 3, false, 0)).toBe(false);
    });

    it("returns true when total turns > maxRecentTurns and new turns exist", () => {
      expect(shouldUpdateSummary(4, 3, false, 0)).toBe(true);
      expect(shouldUpdateSummary(10, 3, false, 5)).toBe(true);
    });

    it("returns false when update is in progress", () => {
      expect(shouldUpdateSummary(10, 3, true, 0)).toBe(false);
    });

    it("returns false when no new turns since last summary", () => {
      expect(shouldUpdateSummary(5, 3, false, 5)).toBe(false);
      expect(shouldUpdateSummary(5, 3, false, 6)).toBe(false);
    });
  });

  describe("filterMeaningfulTurns", () => {
    it("filters out heartbeat messages", () => {
      const turns = [
        { user: "heartbeat" },
        { user: "HEARTBEAT_OK" },
        { user: "ping" },
        { user: "Deploy my app" },
      ];
      const result = filterMeaningfulTurns(turns);
      expect(result).toHaveLength(1);
      expect(result[0].user).toBe("Deploy my app");
    });

    it("filters out very short messages", () => {
      const turns = [{ user: "ok" }, { user: "hi" }, { user: "Please deploy the project" }];
      const result = filterMeaningfulTurns(turns);
      expect(result).toHaveLength(1);
      expect(result[0].user).toBe("Please deploy the project");
    });

    it("keeps meaningful messages", () => {
      const turns = [
        { user: "Deploy my project" },
        { user: "Yes, go ahead" },
        { user: "Configure nginx" },
      ];
      const result = filterMeaningfulTurns(turns);
      expect(result).toHaveLength(3);
    });

    it("handles empty input", () => {
      expect(filterMeaningfulTurns([])).toHaveLength(0);
    });
  });

  describe("formatTurnsForSummary", () => {
    it("formats turns with numbering", () => {
      const result = formatTurnsForSummary([
        { user: "Hello" },
        { user: "Deploy", assistant: "Sure, I'll help" },
      ]);

      expect(result).toContain("1.\n  User: Hello");
      expect(result).toContain("2.\n  Assistant: Sure, I'll help\n  User: Deploy");
    });

    it("handles turns without assistant", () => {
      const result = formatTurnsForSummary([{ user: "Hello" }]);
      expect(result).toBe("1.\n  User: Hello");
    });

    it("filters out heartbeat turns before formatting", () => {
      const result = formatTurnsForSummary([
        { user: "heartbeat" },
        { user: "Deploy my app" },
        { user: "ping" },
      ]);
      // Only "Deploy my app" should remain
      expect(result).toContain("Deploy my app");
      expect(result).not.toContain("heartbeat");
      expect(result).not.toContain("ping");
    });
  });

  describe("buildInitialSummaryPrompt", () => {
    it("includes turns in the prompt", () => {
      const prompt = buildInitialSummaryPrompt([
        { user: "Deploy my project" },
        { user: "Yes, use make build" },
      ]);

      expect(prompt).toContain("Summarize the user's requests");
      expect(prompt).toContain("Deploy my project");
      expect(prompt).toContain("Yes, use make build");
    });
  });

  describe("buildUpdateSummaryPrompt", () => {
    it("includes existing summary and new turns", () => {
      const prompt = buildUpdateSummaryPrompt("User is deploying a web app", [
        { user: "Now configure nginx" },
      ]);

      expect(prompt).toContain("Current summary:");
      expect(prompt).toContain("User is deploying a web app");
      expect(prompt).toContain("New conversation turns:");
      expect(prompt).toContain("Now configure nginx");
    });
  });

  describe("generateSummary", () => {
    it("calls callForText with summary prompts", async () => {
      vi.mocked(callForText).mockResolvedValue("User is deploying a web app");

      const result = await generateSummary({
        model: {
          provider: "test",
          modelId: "test-model",
          baseUrl: "https://api.example.com",
          apiKey: "key",
          api: "openai-completions",
        },
        existingSummary: undefined,
        turns: [{ user: "Deploy my project" }],
        timeoutMs: 20000,
      });

      expect(result).toBe("User is deploying a web app");
      expect(callForText).toHaveBeenCalledOnce();
      expect(callForText).toHaveBeenCalledWith(
        expect.objectContaining({
          userPrompt: expect.stringContaining("Deploy my project"),
        }),
      );
    });

    it("uses update prompt when existing summary provided", async () => {
      vi.mocked(callForText).mockResolvedValue("Updated summary");

      await generateSummary({
        model: {
          provider: "test",
          modelId: "test-model",
          baseUrl: "https://api.example.com",
          apiKey: "key",
          api: "openai-completions",
        },
        existingSummary: "Previous summary",
        turns: [{ user: "New request" }],
        timeoutMs: 20000,
      });

      expect(callForText).toHaveBeenCalledWith(
        expect.objectContaining({
          userPrompt: expect.stringContaining("Current summary:"),
        }),
      );
    });

    it("returns existing summary when no turns provided", async () => {
      const result = await generateSummary({
        model: {
          provider: "test",
          modelId: "test-model",
          api: "openai-completions",
        },
        existingSummary: "Existing summary",
        turns: [],
        timeoutMs: 20000,
      });

      expect(result).toBe("Existing summary");
      expect(callForText).not.toHaveBeenCalled();
    });

    it("returns existing summary when all turns are trivial", async () => {
      const result = await generateSummary({
        model: {
          provider: "test",
          modelId: "test-model",
          api: "openai-completions",
        },
        existingSummary: "Existing summary",
        turns: [{ user: "heartbeat" }, { user: "ping" }],
        timeoutMs: 20000,
      });

      expect(result).toBe("Existing summary");
      expect(callForText).not.toHaveBeenCalled();
    });

    it("returns undefined when callForText fails", async () => {
      vi.mocked(callForText).mockResolvedValue(undefined);

      const result = await generateSummary({
        model: {
          provider: "test",
          modelId: "test-model",
          api: "openai-completions",
        },
        existingSummary: undefined,
        turns: [{ user: "Test" }],
        timeoutMs: 20000,
      });

      expect(result).toBeUndefined();
    });
  });
});
