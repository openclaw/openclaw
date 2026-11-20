import { describe, expect, it } from "vitest";
import { selectCurrentInboundContext } from "./project.js";

describe("context serialization projection", () => {
  it("uses the compact projection and reports durable-id removals", () => {
    const selected = selectCurrentInboundContext({
      context: {
        text: "verbose context with repeated history",
        compactText: 'Context: {"message_id":"42"}',
        serializationStats: { removedSessionMessages: 2, deduplicatedMessages: 1 },
      },
      serialization: { mode: "compact", source: "agent-profile" },
    });

    expect(selected.text).toBe('Context: {"message_id":"42"}');
    expect(selected.report).toEqual({
      mode: "compact",
      source: "agent-profile",
      defaultChars: 37,
      serializedChars: 28,
      removedSessionMessages: 2,
      deduplicatedMessages: 1,
    });
  });

  it("does not report compact removals in default mode", () => {
    const selected = selectCurrentInboundContext({
      context: {
        text: "default context",
        compactText: "compact context",
        serializationStats: { removedSessionMessages: 2, deduplicatedMessages: 1 },
      },
      serialization: { mode: "default", source: "fallback" },
    });

    expect(selected.report.removedSessionMessages).toBe(0);
    expect(selected.report.deduplicatedMessages).toBe(0);
  });
});
