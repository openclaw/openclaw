import { describe, expect, test } from "vitest";
import { __testing, buildCompactBoundaryMetadata } from "./compact-boundary-metadata.js";

describe("compact-boundary-metadata", () => {
  test("builds the minimal compact boundary metadata state", () => {
    const metadata = buildCompactBoundaryMetadata({
      diagId: "diag-1",
      createdAt: 123,
      sessionKey: " session-main ",
      sessionId: "session-id",
      sessionAgentId: "agent-main",
      channel: "discord",
      accountId: "account-1",
      targetId: "user-1",
      threadId: 42,
      messageId: " msg-1 ",
      sandboxEnabled: true,
      sandboxWorkspaceAccess: "read-write",
      bashElevated: false,
      provider: "openai",
      model: "gpt-test",
      thinkLevel: "high",
      trigger: "manual",
    });

    expect(metadata).toEqual({
      version: 1,
      type: "compact.boundary",
      boundaryId: "compact-boundary:diag-1",
      createdAt: 123,
      state: {
        sessionBinding: {
          sessionKey: "session-main",
          sessionId: "session-id",
          agentId: "agent-main",
          channel: "discord",
          accountId: "account-1",
          threadId: "42",
          messageId: "msg-1",
        },
        approval: {
          captured: false,
          reason: "approval live state is captured by the dedicated approval mismatch guard",
        },
        outbound: {
          channel: "discord",
          targetId: "user-1",
          threadId: "42",
          replyToMessageId: "msg-1",
        },
        children: {
          pendingDescendantState: "live-query-required",
          livePendingDescendants: undefined,
        },
        policy: {
          sandboxEnabled: true,
          sandboxWorkspaceAccess: "read-write",
          bashElevated: false,
          provider: "openai",
          model: "gpt-test",
          thinkingLevel: "high",
          trigger: "manual",
        },
      },
    });
  });

  test("normalizes only compact boundary primitives", () => {
    expect(__testing.compactBoundaryString(" value ")).toBe("value");
    expect(__testing.compactBoundaryString(123)).toBe("123");
    expect(__testing.compactBoundaryString("   ")).toBeUndefined();
    expect(__testing.compactBoundaryString(Number.NaN)).toBeUndefined();
    expect(__testing.compactBoundaryBoolean(true)).toBe(true);
    expect(__testing.compactBoundaryBoolean("true")).toBeUndefined();
  });
});
