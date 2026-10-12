// Regression for issue #158945: a CLI-runtime (claude-cli) sessions_spawn call
// carries the current conversation in currentChannelId/currentThreadTs but has no
// agentTo. Thread binding must fall back to those current fields when no explicit
// recipient exists (instead of reading agentTo alone and failing to bind), while
// an explicit agentTo/agentThreadId still wins for regular channel turns.
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

  it("prefers currentMessagingTarget over currentChannelId on a CLI turn with no agentTo", () => {
    expect(
      resolveSpawnRequesterConversationTarget({
        currentMessagingTarget: "channel:resolved",
        currentChannelId: "guild:fallback",
        currentThreadTs: "999",
        agentTo: undefined,
        agentThreadId: undefined,
      }),
    ).toEqual({ to: "channel:resolved", threadId: "999" });
  });

  it("keeps the explicit agentTo/agentThreadId binding even when ambient current fields exist", () => {
    // A channel turn can explicitly direct the spawn at a target that differs
    // from the ambient current conversation; thread binding must follow the
    // explicit recipient, while delivery continues to use the current target.
    expect(
      resolveSpawnRequesterConversationTarget({
        currentMessagingTarget: "channel:source",
        currentChannelId: "source-native",
        currentThreadTs: "999",
        agentTo: "channel:123",
        agentThreadId: "456",
      }),
    ).toEqual({ to: "channel:123", threadId: "456" });
  });

  it("pairs explicit agentTo with agentThreadId only — ambient currentThreadTs does not follow", () => {
    // Regression for ClawSweeper Rev 7 P1: an explicit recipient paired with a
    // missing explicit thread must NOT fall back to the ambient currentThreadTs.
    // Otherwise the channel resolver treats that ambient thread id as the child's
    // conversation id and binds the explicit destination to a thread that belongs
    // to a different ambient conversation (mixed conversation identity).
    expect(
      resolveSpawnRequesterConversationTarget({
        currentMessagingTarget: "channel:source",
        currentChannelId: "source-native",
        currentThreadTs: "999",
        agentTo: "channel:123",
        agentThreadId: undefined,
      }),
    ).toEqual({ to: "channel:123" });
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

  it("binds a CLI run-bound grant turn from caller-supplied-looking but immutable current fields", () => {
    // The run-bound grant copies the gateway's immutable context; its current
    // channel is trusted for binding even though it travels in current*.
    expect(
      resolveSpawnRequesterConversationTarget({
        currentConversationOrigin: "run-bound-grant",
        currentMessagingTarget: undefined,
        currentChannelId: "guild:123",
        currentThreadTs: "456",
        agentTo: undefined,
        agentThreadId: undefined,
      }),
    ).toEqual({ to: "guild:123", threadId: "456" });
  });

  it("does not use caller-writable generic-token current fields as a binding target", () => {
    // A generic loopback bearer can rewrite x-openclaw-current-channel-id. Its
    // ambient current conversation may still drive delivery, but must not select
    // the child-thread binding target: fail closed to an empty binding target.
    expect(
      resolveSpawnRequesterConversationTarget({
        currentConversationOrigin: "caller-token",
        currentMessagingTarget: "room:ambient",
        currentChannelId: "room:scope-shopped",
        currentThreadTs: "456",
        agentTo: undefined,
        agentThreadId: undefined,
      }),
    ).toEqual({});
  });

  it("keeps an explicit agentTo binding on a caller-token turn despite untrusted ambient fields", () => {
    // Explicit host-minted recipients remain authoritative; only the ambient
    // current* fallback is gated. (On loopback agentTo cannot come from headers,
    // but the resolver must honor it whenever the host supplies one.)
    expect(
      resolveSpawnRequesterConversationTarget({
        currentConversationOrigin: "caller-token",
        currentMessagingTarget: "room:ambient",
        currentChannelId: "room:scope-shopped",
        currentThreadTs: "456",
        agentTo: "channel:host-directed",
        agentThreadId: "789",
      }),
    ).toEqual({ to: "channel:host-directed", threadId: "789" });
  });
});
