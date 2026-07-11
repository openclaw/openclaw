// Qqbot tests cover log plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { debugLog, sanitizeDebugLogValue } from "./log.js";

const originalDebug = process.env.QQBOT_DEBUG;

afterEach(() => {
  if (originalDebug === undefined) {
    delete process.env.QQBOT_DEBUG;
  } else {
    process.env.QQBOT_DEBUG = originalDebug;
  }
  vi.restoreAllMocks();
});

describe("QQBot debug logging", () => {
  it("neutralizes control characters in log values", () => {
    expect(sanitizeDebugLogValue("before\nforged\r\tentry")).toBe("before forged entry");
  });

  it.each([
    { name: "drops a pair crossing the cap", prefixLength: 4095, expectedEmoji: "" },
    { name: "keeps a pair ending at the cap", prefixLength: 4094, expectedEmoji: "🎉" },
  ])("$name", ({ prefixLength, expectedEmoji }) => {
    const prefix = "x".repeat(prefixLength);
    expect(sanitizeDebugLogValue(`${prefix}🎉tail`)).toBe(`${prefix}${expectedEmoji}...`);
  });

  it("sanitizes arguments before debug console output", () => {
    process.env.QQBOT_DEBUG = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    debugLog("prefix", "line one\nline two");

    expect(logSpy).toHaveBeenCalledWith("prefix line one line two");
  });

  it.each(["0", "false", "off", "no"])(
    "does not enable debug logging for QQBOT_DEBUG=%s",
    (value) => {
      process.env.QQBOT_DEBUG = value;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      debugLog("private message text");

      expect(logSpy).not.toHaveBeenCalled();
    },
  );
});
