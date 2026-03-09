import { describe, expect, it } from "vitest";
import {
  buildApiErrorNotice,
  buildToolOnlyTurnNudgeMessage,
  DEFAULT_MAX_CONSECUTIVE_TOOL_ONLY_TURNS,
  DEFAULT_NOTIFY_USER_ON_API_ERROR,
  resolveToolOnlyTurnSafetyConfig,
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

describe("buildToolOnlyTurnNudgeMessage", () => {
  it("includes the consecutive turn count", () => {
    const msg = buildToolOnlyTurnNudgeMessage(15);
    expect(msg).toContain("15 consecutive tool calls");
    expect(msg).toContain("reply to the user");
  });

  it("works with custom counts", () => {
    const msg = buildToolOnlyTurnNudgeMessage(5);
    expect(msg).toContain("5 consecutive tool calls");
  });

  it("asks the agent to summarise and reply", () => {
    const msg = buildToolOnlyTurnNudgeMessage(10);
    expect(msg).toContain("summarise your progress");
    expect(msg).toContain("reply to the user");
  });
});

describe("buildApiErrorNotice", () => {
  it("returns notice with error summary when enabled", () => {
    const config = resolveToolOnlyTurnSafetyConfig({ notifyUserOnApiError: true });
    const notice = buildApiErrorNotice("overloaded_error", config);
    expect(notice).not.toBeNull();
    expect(notice).toContain("overloaded_error");
    expect(notice).toContain("⚠️");
    expect(notice).toContain("retrying automatically");
  });

  it("returns null when notifyUserOnApiError is disabled", () => {
    const config = resolveToolOnlyTurnSafetyConfig({ notifyUserOnApiError: false });
    const notice = buildApiErrorNotice("overloaded_error", config);
    expect(notice).toBeNull();
  });

  it("includes the error summary in the message", () => {
    const config = resolveToolOnlyTurnSafetyConfig();
    const notice = buildApiErrorNotice("rate_limit_exceeded", config);
    expect(notice).toContain("rate_limit_exceeded");
  });
});
