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

  it("sanitizes arguments before debug console output", () => {
    process.env.QQBOT_DEBUG = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    debugLog("prefix", "line one\nline two");

    expect(logSpy).toHaveBeenCalledWith("prefix line one line two");
  });

  it.each([
    ["0", "false-like numeric"],
    ["false", "false-like boolean"],
    ["off", "off"],
    ["no", "no"],
    ["disabled", "disabled"],
    ["", "empty string"],
    ["FALSE", "uppercase false"],
    ["  0  ", "padded zero"],
  ])("keeps debug output suppressed when QQBOT_DEBUG=%s (%s) (#82644)", (value) => {
    process.env.QQBOT_DEBUG = value;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    debugLog("private message");

    expect(logSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["1", "truthy numeric"],
    ["true", "true"],
    ["yes", "yes"],
    ["on", "on"],
    ["TRUE", "uppercase true"],
  ])("emits debug output when QQBOT_DEBUG=%s (%s) (#82644)", (value) => {
    process.env.QQBOT_DEBUG = value;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    debugLog("ok");

    expect(logSpy).toHaveBeenCalledOnce();
  });
});
