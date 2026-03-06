import { afterEach, describe, expect, it } from "vitest";
import {
  checkAfterLlmCallGate,
  clearAfterLlmCallGate,
  setAfterLlmCallGate,
} from "./after-llm-call-gate.js";

const SESSION = "test-session-1";

afterEach(() => {
  clearAfterLlmCallGate(SESSION);
});

describe("after-llm-call-gate", () => {
  it("returns not blocked when no gate is set", () => {
    expect(checkAfterLlmCallGate(SESSION)).toEqual({ blocked: false });
  });

  it("blocks all tools when gate.blocked is true", () => {
    setAfterLlmCallGate(SESSION, {
      blocked: true,
      blockReason: "tainted context",
      iteration: 1,
    });
    const result = checkAfterLlmCallGate(SESSION, "tc-1");
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("tainted context");
  });

  it("uses default reason when blockReason is omitted", () => {
    setAfterLlmCallGate(SESSION, { blocked: true, iteration: 1 });
    const result = checkAfterLlmCallGate(SESSION);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("Blocked by after_llm_call hook");
  });

  it("allows tool calls in the allowedToolCallIds set", () => {
    setAfterLlmCallGate(SESSION, {
      blocked: false,
      allowedToolCallIds: new Set(["tc-1", "tc-3"]),
      iteration: 1,
    });
    expect(checkAfterLlmCallGate(SESSION, "tc-1").blocked).toBe(false);
    expect(checkAfterLlmCallGate(SESSION, "tc-3").blocked).toBe(false);
  });

  it("blocks tool calls not in the allowedToolCallIds set", () => {
    setAfterLlmCallGate(SESSION, {
      blocked: false,
      allowedToolCallIds: new Set(["tc-1"]),
      iteration: 1,
    });
    const result = checkAfterLlmCallGate(SESSION, "tc-2");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("tc-2");
    expect(result.reason).toContain("filtered");
  });

  it("blocks when toolCallId is missing but allowedToolCallIds is set", () => {
    setAfterLlmCallGate(SESSION, {
      blocked: false,
      allowedToolCallIds: new Set(["tc-1"]),
      iteration: 1,
    });
    // Without a toolCallId, we can't verify against the allowlist — must block
    const result = checkAfterLlmCallGate(SESSION);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("no ID");
  });

  it("clearAfterLlmCallGate removes the gate", () => {
    setAfterLlmCallGate(SESSION, { blocked: true, iteration: 1 });
    expect(checkAfterLlmCallGate(SESSION).blocked).toBe(true);
    clearAfterLlmCallGate(SESSION);
    expect(checkAfterLlmCallGate(SESSION).blocked).toBe(false);
  });

  it("gates are isolated per session", () => {
    const OTHER = "test-session-2";
    setAfterLlmCallGate(SESSION, { blocked: true, iteration: 1 });
    expect(checkAfterLlmCallGate(SESSION).blocked).toBe(true);
    expect(checkAfterLlmCallGate(OTHER).blocked).toBe(false);
    clearAfterLlmCallGate(OTHER);
  });

  it("overwriting gate replaces previous decisions", () => {
    setAfterLlmCallGate(SESSION, {
      blocked: false,
      allowedToolCallIds: new Set(["tc-1"]),
      iteration: 1,
    });
    expect(checkAfterLlmCallGate(SESSION, "tc-2").blocked).toBe(true);
    // New gate allows all (no filter)
    setAfterLlmCallGate(SESSION, { blocked: false, iteration: 2 });
    expect(checkAfterLlmCallGate(SESSION, "tc-2").blocked).toBe(false);
  });

  it("block takes precedence over allowedToolCallIds", () => {
    setAfterLlmCallGate(SESSION, {
      blocked: true,
      blockReason: "blanket block",
      allowedToolCallIds: new Set(["tc-1"]),
      iteration: 1,
    });
    // Even though tc-1 is in the allowed set, blocked=true overrides
    const result = checkAfterLlmCallGate(SESSION, "tc-1");
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("blanket block");
  });
});
