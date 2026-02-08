import { describe, it, expect } from "vitest";
import {
  pickSummaryFromOutput,
  pickSummaryFromPayloads,
  pickLastNonEmptyTextFromPayloads,
  isHeartbeatOnlyResponse,
  resolveHeartbeatAckMaxChars,
} from "./helpers.js";

describe("isolated-turn helpers", () => {
  describe("pickSummaryFromOutput", () => {
    it("returns undefined for empty text", () => {
      expect(pickSummaryFromOutput("")).toBeUndefined();
      expect(pickSummaryFromOutput("   ")).toBeUndefined();
      expect(pickSummaryFromOutput(undefined)).toBeUndefined();
    });

    it("returns trimmed text when within limit", () => {
      expect(pickSummaryFromOutput("  hello world  ")).toBe("hello world");
    });

    it("truncates text over 2000 chars", () => {
      const longText = "a".repeat(2500);
      const result = pickSummaryFromOutput(longText);
      expect(result).toHaveLength(2001); // 2000 + "…"
      expect(result?.endsWith("…")).toBe(true);
    });
  });

  describe("pickSummaryFromPayloads", () => {
    it("returns undefined for empty payloads", () => {
      expect(pickSummaryFromPayloads([])).toBeUndefined();
    });

    it("returns last non-empty summary", () => {
      const payloads = [{ text: "first" }, { text: "" }, { text: "third" }];
      expect(pickSummaryFromPayloads(payloads)).toBe("third");
    });

    it("skips payloads with only whitespace", () => {
      const payloads = [{ text: "first" }, { text: "   " }];
      expect(pickSummaryFromPayloads(payloads)).toBe("first");
    });
  });

  describe("pickLastNonEmptyTextFromPayloads", () => {
    it("returns undefined for empty payloads", () => {
      expect(pickLastNonEmptyTextFromPayloads([])).toBeUndefined();
    });

    it("returns last non-empty text", () => {
      const payloads = [{ text: "first" }, { text: "" }, { text: "third" }];
      expect(pickLastNonEmptyTextFromPayloads(payloads)).toBe("third");
    });

    it("does not truncate text", () => {
      const longText = "a".repeat(5000);
      const payloads = [{ text: longText }];
      expect(pickLastNonEmptyTextFromPayloads(payloads)).toBe(longText);
    });
  });

  describe("isHeartbeatOnlyResponse", () => {
    it("returns true for empty payloads", () => {
      expect(isHeartbeatOnlyResponse([], 10)).toBe(true);
    });

    it("returns true for HEARTBEAT_OK only", () => {
      expect(isHeartbeatOnlyResponse([{ text: "HEARTBEAT_OK" }], 10)).toBe(true);
    });

    it("returns false when media is present", () => {
      expect(
        isHeartbeatOnlyResponse(
          [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" }],
          10,
        ),
      ).toBe(false);
    });

    it("returns false when mediaUrls is present", () => {
      expect(
        isHeartbeatOnlyResponse(
          [{ text: "HEARTBEAT_OK", mediaUrls: ["https://example.com/img.png"] }],
          10,
        ),
      ).toBe(false);
    });
  });

  describe("resolveHeartbeatAckMaxChars", () => {
    it("returns default when no config", () => {
      expect(resolveHeartbeatAckMaxChars(undefined)).toBeGreaterThan(0);
    });

    it("returns configured value", () => {
      expect(resolveHeartbeatAckMaxChars({ heartbeat: { ackMaxChars: 50 } })).toBe(50);
    });

    it("clamps negative values to 0", () => {
      expect(resolveHeartbeatAckMaxChars({ heartbeat: { ackMaxChars: -10 } })).toBe(0);
    });
  });
});
