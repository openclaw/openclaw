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
