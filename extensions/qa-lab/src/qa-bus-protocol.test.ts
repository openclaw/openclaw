import { describe, expect, it } from "vitest";
import {
  buildQaConversationTarget,
  parseQaTarget,
  sanitizeQaBusToolCalls,
} from "./qa-bus-protocol.js";

describe("QA Lab package bus protocol", () => {
  it.each(["direct", "group", "channel"] as const)(
    "builds the canonical base target for %s conversations",
    (chatType) => {
      const conversationId = "Case/Room";
      expect(buildQaConversationTarget({ chatType, conversationId })).toBe(
        `${chatType === "direct" ? "dm" : chatType}:${conversationId}`,
      );
    },
  );

  it("defaults bare targets to direct conversations", () => {
    expect(parseQaTarget("bare-id")).toEqual({
      chatType: "direct",
      conversationId: "bare-id",
    });
  });

  it.each(["", "CHANNEL:CaseSensitive", "thread:Room/", "thread:/v1/group/Room/%GG", "dm:"])(
    "rejects malformed targets for %j",
    (target) => {
      expect(() => parseQaTarget(target)).toThrow();
    },
  );

  it("redacts and bounds tool-call arguments", () => {
    const toolCalls = [
      null,
      { name: 123 },
      {
        name: " exec ",
        arguments: {
          command: "cat README.md",
          apiToken: "secret-token",
          headers: { Authorization: "Bearer secret" },
          values: ["ok", { password: "hunter2" }],
          nested: { one: { two: { three: { four: "truncated" } } } },
          finite: 42,
          infinite: Number.POSITIVE_INFINITY,
          bigint: 123n,
          omitted: undefined,
        },
      },
    ];

    expect(sanitizeQaBusToolCalls(toolCalls)).toEqual([
      {
        name: "exec",
        arguments: {
          command: "[redacted]",
          apiToken: "[redacted]",
          headers: { Authorization: "[redacted]" },
          values: ["[redacted]", { password: "[redacted]" }],
          nested: { one: { two: { three: "[truncated]" } } },
          finite: 42,
          infinite: "Infinity",
          bigint: "123",
        },
      },
    ]);
  });
});
