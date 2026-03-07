import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONSECUTIVE_TOOL_ONLY_TURNS,
  DEFAULT_NOTIFY_USER_ON_API_ERROR,
  resolveToolOnlyTurnSafetyConfig,
  ToolOnlyTurnTracker,
} from "./tool-only-turn-safety.js";

describe("resolveToolOnlyTurnSafetyConfig", () => {
  it("returns defaults when no config is provided", () => {
    const cfg = resolveToolOnlyTurnSafetyConfig();
    expect(cfg.maxConsecutiveToolOnlyTurns).toBe(DEFAULT_MAX_CONSECUTIVE_TOOL_ONLY_TURNS);
    expect(cfg.notifyUserOnApiError).toBe(DEFAULT_NOTIFY_USER_ON_API_ERROR);
  });

  it("returns defaults when config is empty", () => {
    const cfg = resolveToolOnlyTurnSafetyConfig({});
    expect(cfg.maxConsecutiveToolOnlyTurns).toBe(15);
    expect(cfg.notifyUserOnApiError).toBe(true);
  });

  it("accepts valid overrides", () => {
    const cfg = resolveToolOnlyTurnSafetyConfig({
      maxConsecutiveToolOnlyTurns: 10,
      notifyUserOnApiError: false,
    });
    expect(cfg.maxConsecutiveToolOnlyTurns).toBe(10);
    expect(cfg.notifyUserOnApiError).toBe(false);
  });

  it("allows 0 to disable tool-only turn safety", () => {
    const cfg = resolveToolOnlyTurnSafetyConfig({ maxConsecutiveToolOnlyTurns: 0 });
    expect(cfg.maxConsecutiveToolOnlyTurns).toBe(0);
  });

  it("falls back to default for negative numbers", () => {
    const cfg = resolveToolOnlyTurnSafetyConfig({ maxConsecutiveToolOnlyTurns: -5 });
    expect(cfg.maxConsecutiveToolOnlyTurns).toBe(15);
  });

  it("falls back to default for non-integer values", () => {
    const cfg = resolveToolOnlyTurnSafetyConfig({ maxConsecutiveToolOnlyTurns: 3.5 });
    expect(cfg.maxConsecutiveToolOnlyTurns).toBe(15);
  });
});

describe("ToolOnlyTurnTracker", () => {
  const defaultConfig = resolveToolOnlyTurnSafetyConfig();

  describe("recordTextReply / recordToolOnlyTurn", () => {
    it("starts with count 0 and no reply", () => {
      const tracker = new ToolOnlyTurnTracker(defaultConfig);
      expect(tracker.count).toBe(0);
      expect(tracker.hasReplied).toBe(false);
    });

    it("increments count on tool-only turns", () => {
      const tracker = new ToolOnlyTurnTracker(defaultConfig);
      tracker.recordToolOnlyTurn();
      tracker.recordToolOnlyTurn();
      tracker.recordToolOnlyTurn();
      expect(tracker.count).toBe(3);
    });

    it("resets count on text reply", () => {
      const tracker = new ToolOnlyTurnTracker(defaultConfig);
      tracker.recordToolOnlyTurn();
      tracker.recordToolOnlyTurn();
      tracker.recordTextReply();
      expect(tracker.count).toBe(0);
      expect(tracker.hasReplied).toBe(true);
    });
  });

  describe("checkNudge", () => {
    it("returns null before threshold is reached", () => {
      const tracker = new ToolOnlyTurnTracker(
        resolveToolOnlyTurnSafetyConfig({
          maxConsecutiveToolOnlyTurns: 5,
        }),
      );
      for (let i = 0; i < 4; i++) {
        tracker.recordToolOnlyTurn();
      }
      expect(tracker.checkNudge()).toBeNull();
    });

    it("returns nudge message when threshold is reached", () => {
      const tracker = new ToolOnlyTurnTracker(
        resolveToolOnlyTurnSafetyConfig({
          maxConsecutiveToolOnlyTurns: 5,
        }),
      );
      for (let i = 0; i < 5; i++) {
        tracker.recordToolOnlyTurn();
      }
      const nudge = tracker.checkNudge();
      expect(nudge).not.toBeNull();
      expect(nudge).toContain("5 consecutive tool calls");
      expect(nudge).toContain("reply to the user");
    });

    it("returns nudge only once per streak", () => {
      const tracker = new ToolOnlyTurnTracker(
        resolveToolOnlyTurnSafetyConfig({
          maxConsecutiveToolOnlyTurns: 3,
        }),
      );
      for (let i = 0; i < 3; i++) {
        tracker.recordToolOnlyTurn();
      }
      const first = tracker.checkNudge();
      expect(first).not.toBeNull();

      tracker.recordToolOnlyTurn();
      const second = tracker.checkNudge();
      expect(second).toBeNull();
    });

    it("resets nudge flag after text reply", () => {
      const tracker = new ToolOnlyTurnTracker(
        resolveToolOnlyTurnSafetyConfig({
          maxConsecutiveToolOnlyTurns: 3,
        }),
      );
      for (let i = 0; i < 3; i++) {
        tracker.recordToolOnlyTurn();
      }
      expect(tracker.checkNudge()).not.toBeNull();

      tracker.recordTextReply();
      for (let i = 0; i < 3; i++) {
        tracker.recordToolOnlyTurn();
      }
      const nudge = tracker.checkNudge();
      expect(nudge).not.toBeNull();
      expect(nudge).toContain("3 consecutive tool calls");
    });

    it("returns null when disabled (threshold=0)", () => {
      const tracker = new ToolOnlyTurnTracker(
        resolveToolOnlyTurnSafetyConfig({
          maxConsecutiveToolOnlyTurns: 0,
        }),
      );
      for (let i = 0; i < 100; i++) {
        tracker.recordToolOnlyTurn();
      }
      expect(tracker.checkNudge()).toBeNull();
    });
  });

  describe("buildApiErrorNotice", () => {
    it("returns notice when no text reply has been sent", () => {
      const tracker = new ToolOnlyTurnTracker(defaultConfig);
      const notice = tracker.buildApiErrorNotice("overloaded_error");
      expect(notice).not.toBeNull();
      expect(notice).toContain("overloaded_error");
      expect(notice).toContain("⚠️");
    });

    it("returns null after text reply was sent", () => {
      const tracker = new ToolOnlyTurnTracker(defaultConfig);
      tracker.recordTextReply();
      const notice = tracker.buildApiErrorNotice("overloaded_error");
      expect(notice).toBeNull();
    });

    it("returns null when notifyUserOnApiError is disabled", () => {
      const tracker = new ToolOnlyTurnTracker(
        resolveToolOnlyTurnSafetyConfig({
          notifyUserOnApiError: false,
        }),
      );
      const notice = tracker.buildApiErrorNotice("overloaded_error");
      expect(notice).toBeNull();
    });
  });
});
