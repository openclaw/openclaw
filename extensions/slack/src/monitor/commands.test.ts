// Tests for Slack command detection helpers.
import { describe, expect, it } from "vitest";
import { stripSlackMentionsForCommandDetection } from "./commands.js";

describe("stripSlackMentionsForCommandDetection", () => {
  describe("mention stripping (existing behavior)", () => {
    it("strips <@U123> mentions from text", () => {
      expect(stripSlackMentionsForCommandDetection("<@U123> stop")).toBe("stop");
    });

    it("strips <@U123|name> mentions from text", () => {
      expect(stripSlackMentionsForCommandDetection("<@U123|ada> /new")).toBe("/new");
    });

    it("preserves normal text without mentions", () => {
      expect(stripSlackMentionsForCommandDetection("hello world")).toBe("hello world");
    });

    it("handles empty text", () => {
      expect(stripSlackMentionsForCommandDetection("")).toBe("");
    });
  });

  describe("bot display name stripping (new)", () => {
    it('strips "ada" prefix from "ada stop" → "stop"', () => {
      expect(stripSlackMentionsForCommandDetection("ada stop", "ada")).toBe("stop");
    });

    it('strips "ada" prefix from "ada /stop" → "/stop"', () => {
      expect(stripSlackMentionsForCommandDetection("ada /stop", "ada")).toBe("/stop");
    });

    it('returns empty string for bare "ada" with botDisplayName="ada"', () => {
      expect(stripSlackMentionsForCommandDetection("ada", "ada")).toBe("");
    });

    it("case-insensitive: strips ADA from ADA STOP", () => {
      expect(stripSlackMentionsForCommandDetection("ADA STOP", "ada")).toBe("STOP");
    });

    it("case-insensitive: strips Ada from Ada stop", () => {
      expect(stripSlackMentionsForCommandDetection("Ada stop", "ada")).toBe("stop");
    });

    it('does not strip partial prefix: "adalyn stop" with botDisplayName="ada"', () => {
      expect(stripSlackMentionsForCommandDetection("adalyn stop", "ada")).toBe("adalyn stop");
    });

    it("preserves message when botDisplayName is not a prefix", () => {
      expect(stripSlackMentionsForCommandDetection("stop", "ada")).toBe("stop");
    });

    it("works with mention + bot name: <@U123> ada stop", () => {
      expect(stripSlackMentionsForCommandDetection("<@U123> ada stop", "ada")).toBe("stop");
    });

    it("no botDisplayName preserves existing behavior", () => {
      expect(stripSlackMentionsForCommandDetection("ada stop")).toBe("ada stop");
    });

    it('strips multi-word bot name: "openclaw bot stop" → "stop"', () => {
      expect(stripSlackMentionsForCommandDetection("openclaw bot stop", "openclaw bot")).toBe(
        "stop",
      );
    });

    it("only strips bot name as space-delimited prefix, not mid-text", () => {
      expect(stripSlackMentionsForCommandDetection("please ada stop", "ada")).toBe(
        "please ada stop",
      );
    });

    it("handles undefined botDisplayName gracefully", () => {
      expect(stripSlackMentionsForCommandDetection("ada stop", undefined)).toBe("ada stop");
    });

    it("handles empty botDisplayName gracefully", () => {
      expect(stripSlackMentionsForCommandDetection("ada stop", "")).toBe("ada stop");
    });
  });
});
