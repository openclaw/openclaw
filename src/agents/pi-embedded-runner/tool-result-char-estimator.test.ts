import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateMessageCharsCached,
} from "./tool-result-char-estimator.js";

function makeUser(text: string): AgentMessage {
  return castAgentMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

describe("estimateMessageCharsCached", () => {
  it("returns a positive estimate for a valid message", () => {
    const cache = createMessageCharEstimateCache();
    const msg = makeUser("hello world");
    expect(estimateMessageCharsCached(msg, cache)).toBeGreaterThan(0);
  });

  it("returns 0 for null", () => {
    const cache = createMessageCharEstimateCache();
    expect(estimateMessageCharsCached(null as unknown as AgentMessage, cache)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    const cache = createMessageCharEstimateCache();
    expect(estimateMessageCharsCached(undefined as unknown as AgentMessage, cache)).toBe(0);
  });

  it("returns 0 for a non-object primitive", () => {
    const cache = createMessageCharEstimateCache();
    expect(estimateMessageCharsCached(42 as unknown as AgentMessage, cache)).toBe(0);
  });

  it("caches the estimate on second call", () => {
    const cache = createMessageCharEstimateCache();
    const msg = makeUser("cached test");
    const first = estimateMessageCharsCached(msg, cache);
    const second = estimateMessageCharsCached(msg, cache);
    expect(first).toBe(second);
    expect(first).toBeGreaterThan(0);
  });
});

describe("estimateContextChars", () => {
  it("sums estimates for valid messages", () => {
    const cache = createMessageCharEstimateCache();
    const messages = [makeUser("one"), makeUser("two")];
    const total = estimateContextChars(messages, cache);
    expect(total).toBeGreaterThan(0);
  });

  it("skips null entries without crashing", () => {
    const cache = createMessageCharEstimateCache();
    const messages = [
      makeUser("valid"),
      null as unknown as AgentMessage,
      makeUser("also valid"),
    ];
    const total = estimateContextChars(messages, cache);
    expect(total).toBeGreaterThan(0);
  });

  it("skips undefined entries without crashing", () => {
    const cache = createMessageCharEstimateCache();
    const messages = [
      undefined as unknown as AgentMessage,
      makeUser("valid"),
    ];
    const total = estimateContextChars(messages, cache);
    expect(total).toBeGreaterThan(0);
  });

  it("handles an entirely null/undefined array", () => {
    const cache = createMessageCharEstimateCache();
    const messages = [
      null as unknown as AgentMessage,
      undefined as unknown as AgentMessage,
    ];
    expect(estimateContextChars(messages, cache)).toBe(0);
  });

  it("handles an empty array", () => {
    const cache = createMessageCharEstimateCache();
    expect(estimateContextChars([], cache)).toBe(0);
  });
});
