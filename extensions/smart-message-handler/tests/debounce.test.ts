import { describe, it, expect, vi } from "vitest";
import { calculateDebounceMultiplier, logDebug } from "../src/debounce.ts";
import type { DebugLogger } from "../src/debounce.ts";
import type { SmartHandlerConfig, SessionState } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

// Helper: build a minimal config by spreading over DEFAULT_CONFIG
function makeConfig(overrides: Partial<SmartHandlerConfig> = {}): SmartHandlerConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// Helper: build a minimal SessionState
function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    lastMessageTime: Date.now(),
    messageCount: 1,
    avgInterval: 0,
    totalIntervals: 0,
    ...overrides,
  };
}

describe("calculateDebounceMultiplier", () => {
  it("returns a multiplier greater than 1.0 for an incomplete message (ends with ...)", () => {
    const config = makeConfig();
    const multiplier = calculateDebounceMultiplier("hello...", undefined, config);
    expect(multiplier > 1.0).toBe(true);
  });

  it("returns a multiplier less than 1.0 for a complete message (ends with 。)", () => {
    const config = makeConfig();
    const multiplier = calculateDebounceMultiplier("请帮我分析一下。", undefined, config);
    expect(multiplier < 1.0).toBe(true);
  });

  it("returns a multiplier less than 1.0 for a complete message ending with ?", () => {
    const config = makeConfig();
    const multiplier = calculateDebounceMultiplier("How are you?", undefined, config);
    expect(multiplier < 1.0).toBe(true);
  });

  it("increases multiplier when session has messageCount > 2", () => {
    const config = makeConfig();
    // Use a neutral message (no incomplete/complete signal) to isolate history effect
    const noHistoryMultiplier = calculateDebounceMultiplier("hello there", undefined, config);
    const withHistoryMultiplier = calculateDebounceMultiplier(
      "hello there",
      makeSession({ messageCount: 5 }),
      config,
    );
    expect(withHistoryMultiplier > noHistoryMultiplier).toBe(true);
  });

  it("does not increase multiplier when session messageCount is <= 2", () => {
    const config = makeConfig();
    const noHistoryMultiplier = calculateDebounceMultiplier("hello there", undefined, config);
    const lowHistoryMultiplier = calculateDebounceMultiplier(
      "hello there",
      makeSession({ messageCount: 2 }),
      config,
    );
    expect(lowHistoryMultiplier).toBe(noHistoryMultiplier);
  });

  it("does not crash on empty message", () => {
    const config = makeConfig();
    expect(() => calculateDebounceMultiplier("", undefined, config)).not.toThrow();
  });

  it("does not crash on whitespace-only message", () => {
    const config = makeConfig();
    expect(() => calculateDebounceMultiplier("   ", undefined, config)).not.toThrow();
  });

  it("never exceeds maxDebounceMultiplier", () => {
    const config = makeConfig({ maxDebounceMultiplier: 2 });
    // Incomplete signal + high message count should push multiplier high
    const multiplier = calculateDebounceMultiplier(
      "sending this and...",
      makeSession({ messageCount: 100 }),
      config,
    );
    expect(multiplier <= config.maxDebounceMultiplier).toBe(true);
  });

  it("caps at maxDebounceMultiplier regardless of session history size", () => {
    const config = makeConfig({ maxDebounceMultiplier: 1.1 });
    const multiplier = calculateDebounceMultiplier(
      "pending...",
      makeSession({ messageCount: 999 }),
      config,
    );
    expect(multiplier <= 1.1).toBe(true);
  });

  it("returns exactly 1.0 baseline for a neutral message with no session history", () => {
    // A message that neither ends with incomplete nor complete signal
    // and no session history: multiplier should be 1.0
    const config = makeConfig();
    const multiplier = calculateDebounceMultiplier("hello there", undefined, config);
    expect(multiplier).toBe(1.0);
  });

  it("history multiplier formula: messageCount=10 yields factor 2.0 (capped at 1.5)", () => {
    const config = makeConfig({ maxDebounceMultiplier: 10 }); // remove cap interference
    // neutral message so incomplete/complete signals don't interfere
    const multiplier = calculateDebounceMultiplier(
      "hello there",
      makeSession({ messageCount: 10 }),
      config,
    );
    // Math: historyMultiplier = min(1 + 10/10, 1.5) = min(2.0, 1.5) = 1.5
    expect(multiplier).toBe(1.5);
  });
});

describe("logDebug", () => {
  it("does not throw when debug is false and no data provided", () => {
    const config = makeConfig({ debug: false });
    expect(() => logDebug(config, "test message")).not.toThrow();
  });

  it("does not throw when debug is true and data is provided", () => {
    const config = makeConfig({ debug: true });
    expect(() => logDebug(config, "test message", { key: "value" })).not.toThrow();
  });

  it("does not throw when debug is false and data is provided", () => {
    const config = makeConfig({ debug: false });
    expect(() => logDebug(config, "should not log", { secret: 42 })).not.toThrow();
  });

  it("calls logger.debug instead of console.log when logger is provided", () => {
    const config = makeConfig({ debug: true });
    const calls: string[] = [];
    const logger: DebugLogger = { debug: (msg: string) => calls.push(msg) };
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logDebug(config, "hello", undefined, logger);

    expect(calls.length).toBe(1);
    expect(calls[0].includes("[smart-message-handler] hello")).toBe(true);
    expect(consoleSpy.mock.calls.length).toBe(0);
    consoleSpy.mockRestore();
  });

  it("falls back to console.log when no logger is provided", () => {
    const config = makeConfig({ debug: true });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logDebug(config, "fallback test");

    expect(consoleSpy.mock.calls.length).toBe(1);
    consoleSpy.mockRestore();
  });

  it("falls back to console.log when logger has no debug method", () => {
    const config = makeConfig({ debug: true });
    const logger: DebugLogger = {};
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logDebug(config, "no debug method", undefined, logger);

    expect(consoleSpy.mock.calls.length).toBe(1);
    consoleSpy.mockRestore();
  });
});
