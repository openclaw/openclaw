// Regression for issue #158945: a CLI-runtime (claude-cli) sessions_spawn call
// carries the current conversation in currentChannelId/currentThreadTs but has no
// agentTo. Thread binding must resolve the requester conversation with the same
// precedence delivery already uses (currentMessagingTarget ?? currentChannelId ??
// agentTo), instead of reading agentTo alone and failing to bind.
import { describe, expect, it } from "vitest";
import { resolveSpawnRequesterConversationTarget } from "./spawn-requester-origin.js";

describe("resolveSpawnRequesterConversationTarget", () => {
  it("binds a CLI-runtime turn from currentChannelId when agentTo is absent", () => {
    expect(
      resolveSpawnRequesterConversationTarget({
        agentTo: undefined,
        agentThreadId: undefined,
        currentMessagingTarget: undefined,
        currentChannelId: "guild:123456789012345678",
        currentThreadTs: undefined,
      }),
    ).toEqual({ to: "guild:123456789012345678" });
  });

  it("binds a CLI-runtime thread from currentChannelId plus currentThreadTs", () => {
    expect(
      resolveSpawnRequesterConversationTarget({
        currentMessagingTarget: undefined,
        currentChannelId: "guild:123456789012345678",
        currentThreadTs: "111222333444555666",
        agentTo: undefined,
        agentThreadId: undefined,
      }),
    ).toEqual({ to: "guild:123456789012345678", threadId: "111222333444555666" });
  });

  it("prefers the explicit current messaging target over channel id and agentTo", () => {
    expect(
      resolveSpawnRequesterConversationTarget({
        currentMessagingTarget: "channel:resolved",
        currentChannelId: "guild:fallback",
        currentThreadTs: "999",
        agentTo: "legacy:to",
        agentThreadId: "888",
      }),
    ).toEqual({ to: "channel:resolved", threadId: "999" });
  });

  it("keeps regular channel turns on the explicit agentTo/agentThreadId path", () => {
    // A normal (non-CLI) turn has no current* fields: result must be identical to
    // the previous behavior, so explicit agentTo policy/binding is unchanged.
    expect(
      resolveSpawnRequesterConversationTarget({
        currentMessagingTarget: undefined,
        currentChannelId: undefined,
        currentThreadTs: undefined,
        agentTo: "room:!parent:example",
        agentThreadId: "$thread-root",
      }),
    ).toEqual({ to: "room:!parent:example", threadId: "$thread-root" });
  });

  it("returns an empty target when no conversation field is resolvable", () => {
    expect(
      resolveSpawnRequesterConversationTarget({
        agentTo: "   ",
        agentThreadId: "",
        currentChannelId: undefined,
        currentThreadTs: undefined,
      }),
    ).toEqual({});
  });
});
