import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { limitHistoryTurns } from "./embedded-agent-runner/history.js";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "./test-helpers/agent-message-fixtures.js";

const makeTurns = (count: number): AgentMessage[] =>
  Array.from({ length: count }, (_, i) => [
    { role: "user" as const, content: `user ${i}`, timestamp: i },
    makeAgentAssistantMessage({
      content: [{ type: "text", text: `assistant ${i}` }],
      timestamp: i,
    }),
  ]).flat();

describe("limitHistoryTurns", () => {
  it.each([undefined, -1])("leaves history unchanged for a disabled limit %s", (limit) => {
    const messages = makeTurns(2);
    expect(limitHistoryTurns(messages, limit)).toBe(messages);
  });

  it("returns empty history", () => {
    expect(limitHistoryTurns([], 5)).toEqual([]);
  });

  it("evicts batches at the hysteresis boundary while preserving intermediate prefixes", () => {
    const messages = makeTurns(13);
    const atThreshold = messages.slice(0, 12);
    expect(limitHistoryTurns(atThreshold, 4)).toBe(atThreshold);
    for (const [offset, start] of [3, 3, 3, 6, 6, 6, 9].entries()) {
      const current = messages.slice(0, (offset + 7) * 2);
      const expected = structuredClone(current.slice(start * 2));
      expect(limitHistoryTurns(current, 4)).toEqual(expected);
    }
  });

  it("preserves leading summaries while limiting whole user turns", () => {
    const summary = castAgentMessage({
      role: "compactionSummary",
      summary: "Prior context",
      tokensBefore: 5000,
      timestamp: 0,
    });
    const messages = [summary, ...makeTurns(3)];
    const expected = structuredClone([summary, ...messages.slice(-2)]);
    expect(limitHistoryTurns(messages, 1)).toEqual(expected);
  });

  it("preserves the reset kept-tail prelude while limiting post-boundary turns", () => {
    const prelude = makeTurns(1);
    for (const message of prelude) {
      Object.defineProperty(message, Symbol.for("openclaw.sessionHistoryPrelude"), { value: true });
    }
    const messages = [...prelude, ...makeTurns(3)];
    const expected = structuredClone([...prelude, ...messages.slice(-2)]);
    expect(limitHistoryTurns(messages, 1)).toEqual(expected);
  });

  it("keeps summary-only history", () => {
    const messages = [
      castAgentMessage({
        role: "compactionSummary",
        summary: "Summary",
        tokensBefore: 1000,
        timestamp: 0,
      }),
    ];
    expect(limitHistoryTurns(messages, 2)).toBe(messages);
  });
});
