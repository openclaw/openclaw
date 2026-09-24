// Slack tests cover reactions plugin behavior.
import type { AllMiddlewareArgs } from "@slack/bolt";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSystemEventRouteResolver } from "../system-event-session.js";

const reactionQueueMock = vi.hoisted(() => vi.fn());
let registerSlackReactionEvents: typeof import("./reactions.js").registerSlackReactionEvents;
let createSlackSystemEventTestHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;
type SlackSystemEventTestOverrides =
  import("./system-event-test-harness.js").SlackSystemEventTestOverrides;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => reactionQueueMock(text, { ...options, sessionKey: route.sessionKey }),
}));
type ReactionHandler = import("./system-event-test-harness.js").SlackSystemEventHandler;

type ReactionRunInput = {
  handler?: "added" | "removed";
  overrides?: SlackSystemEventTestOverrides;
  event?: Record<string, unknown>;
  body?: unknown;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
};

function buildReactionEvent(overrides?: { user?: string; channel?: string }) {
  return {
    type: "reaction_added",
    user: overrides?.user ?? "U1",
    reaction: "thumbsup",
    item: {
      type: "message",
      channel: overrides?.channel ?? "D1",
      ts: "123.456",
    },
    item_user: "UBOT",
  };
}

function buildEnterpriseListenerArgs(teamId: string) {
  return {
    body: { api_app_id: "A_GRID", event_id: `Ev-reaction-${teamId}` },
    context: {
      isEnterpriseInstall: true,
      enterpriseId: "E_GRID",
      teamId,
    } as AllMiddlewareArgs["context"],
    client: { token: `listener-${teamId}` } as AllMiddlewareArgs["client"],
  };
}

function createReactionHandlers(params: {
  overrides?: SlackSystemEventTestOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = createSlackSystemEventTestHarness(params.overrides);
  if (params.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackReactionEvents({ ctx: harness.ctx, trackEvent: params.trackEvent });
  return {
    added: harness.getHandler("reaction_added") as ReactionHandler | null,
    removed: harness.getHandler("reaction_removed") as ReactionHandler | null,
  };
}

function requireReactionHandler(handler: ReactionHandler | null, name: string): ReactionHandler {
  if (!handler) {
    throw new Error(`expected Slack ${name} reaction handler`);
  }
  return handler;
}

async function executeReactionCase(input: ReactionRunInput = {}) {
  reactionQueueMock.mockClear();
  const handlers = createReactionHandlers({
    overrides: input.overrides,
    trackEvent: input.trackEvent,
    shouldDropMismatchedSlackEvent: input.shouldDropMismatchedSlackEvent,
  });
  const handlerName = input.handler ?? "added";
  const handler = requireReactionHandler(handlers[handlerName], handlerName);
  await handler({
    event: (input.event ?? buildReactionEvent()) as Record<string, unknown>,
    body: input.body ?? { event_id: "Ev-reaction-default" },
  });
}

describe("registerSlackReactionEvents", () => {
  beforeAll(async () => {
    ({ registerSlackReactionEvents } = await import("./reactions.js"));
    ({ createSlackSystemEventTestHarness } = await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    reactionQueueMock.mockClear();
  });

  const cases: Array<{ name: string; input: ReactionRunInput; expectedCalls: number }> = [
    {
      name: "enqueues DM reaction system events when dmPolicy is open",
      input: { overrides: { dmPolicy: "open" } },
      expectedCalls: 1,
    },
    {
      name: "blocks DM reaction system events when dmPolicy is disabled",
      input: { overrides: { dmPolicy: "disabled" } },
      expectedCalls: 0,
    },
    {
      name: "blocks DM reaction system events for unauthorized senders in allowlist mode",
      input: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 0,
    },
    {
      name: "allows DM reaction system events for authorized senders in allowlist mode",
      input: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U1"] },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 1,
    },
    {
      name: "enqueues channel reaction events regardless of dmPolicy",
      input: {
        handler: "removed",
        overrides: { dmPolicy: "disabled", channelType: "channel" },
        event: {
          ...buildReactionEvent({ channel: "C1" }),
          type: "reaction_removed",
        },
      },
      expectedCalls: 1,
    },
    {
      name: "blocks channel reaction events for users outside channel users allowlist",
      input: {
        overrides: {
          dmPolicy: "open",
          channelType: "channel",
          channelUsers: ["U_OWNER"],
        },
        event: buildReactionEvent({ channel: "C1", user: "U_ATTACKER" }),
      },
      expectedCalls: 0,
    },
    {
      name: "blocks reactions when reaction notifications are off",
      input: { overrides: { dmPolicy: "open", reactionMode: "off" } },
      expectedCalls: 0,
    },
    {
      name: "blocks own-mode reactions on messages not authored by the bot",
      input: {
        overrides: { dmPolicy: "open", reactionMode: "own" },
        event: {
          ...buildReactionEvent(),
          item_user: "U_OTHER",
        },
      },
      expectedCalls: 0,
    },
    {
      name: "allows own-mode reactions on messages authored by the bot",
      input: {
        overrides: { dmPolicy: "open", reactionMode: "own" },
        event: {
          ...buildReactionEvent(),
          item_user: "U_BOT",
        },
      },
      expectedCalls: 1,
    },
    {
      name: "blocks reactions from senders outside the reaction allowlist",
      input: {
        overrides: {
          dmPolicy: "open",
          reactionMode: "allowlist",
          reactionAllowlist: ["U2"],
        },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 0,
    },
    {
      name: "blocks allowlist-mode reactions when the reaction allowlist is empty",
      input: {
        overrides: {
          dmPolicy: "open",
          reactionMode: "allowlist",
          reactionAllowlist: [],
        },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 0,
    },
    {
      name: "allows reactions from senders inside the reaction allowlist",
      input: {
        overrides: {
          dmPolicy: "open",
          reactionMode: "allowlist",
          reactionAllowlist: ["U1"],
        },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 1,
    },
  ];

  it.each(cases)("$name", async ({ input, expectedCalls }) => {
    await executeReactionCase(input);
    expect(reactionQueueMock).toHaveBeenCalledTimes(expectedCalls);
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await executeReactionCase({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted message reactions", async () => {
    const trackEvent = vi.fn();
    await executeReactionCase({ trackEvent });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("marks queued reaction events as untrusted external content", async () => {
    await executeReactionCase();

    expect(reactionQueueMock).toHaveBeenCalledWith(expect.any(String), {
      sessionKey: "agent:main:main",
      contextKey: "slack:reaction:added:D1:123.456:U1:thumbsup:Ev-reaction-default",
    });
  });

  it("drops off-mode reactions before resolving Slack context", async () => {
    reactionQueueMock.mockClear();
    const harness = createSlackSystemEventTestHarness({ reactionMode: "off" });
    const resolveChannelName = vi.fn(harness.ctx.resolveChannelName);
    const resolveUserName = vi.fn(harness.ctx.resolveUserName);
    harness.ctx.resolveChannelName = resolveChannelName;
    harness.ctx.resolveUserName = resolveUserName;
    registerSlackReactionEvents({ ctx: harness.ctx });
    const handler = requireReactionHandler(
      harness.getHandler("reaction_added") as ReactionHandler | null,
      "added",
    );

    await handler({
      event: buildReactionEvent({ user: "U777", channel: "D123" }),
      body: {},
    });

    expect(resolveChannelName).not.toHaveBeenCalled();
    expect(resolveUserName).not.toHaveBeenCalled();
    expect(reactionQueueMock).not.toHaveBeenCalled();
  });

  it("drops own-mode reactions on non-bot messages before resolving Slack context", async () => {
    reactionQueueMock.mockClear();
    const harness = createSlackSystemEventTestHarness({ reactionMode: "own" });
    const resolveChannelName = vi.fn(harness.ctx.resolveChannelName);
    const resolveUserName = vi.fn(harness.ctx.resolveUserName);
    harness.ctx.resolveChannelName = resolveChannelName;
    harness.ctx.resolveUserName = resolveUserName;
    registerSlackReactionEvents({ ctx: harness.ctx });
    const handler = requireReactionHandler(
      harness.getHandler("reaction_added") as ReactionHandler | null,
      "added",
    );

    await handler({
      event: {
        ...buildReactionEvent({ user: "U777", channel: "D123" }),
        item_user: "U_OTHER",
      },
      body: {},
    });

    expect(resolveChannelName).not.toHaveBeenCalled();
    expect(resolveUserName).not.toHaveBeenCalled();
    expect(reactionQueueMock).not.toHaveBeenCalled();
  });

  it("passes sender context when resolving reaction session keys", async () => {
    reactionQueueMock.mockClear();
    const harness = createSlackSystemEventTestHarness();
    const resolveSessionKey = vi
      .fn()
      .mockReturnValue({ agentId: "ops", sessionKey: "agent:ops:main" });
    harness.ctx.resolveSlackSystemEventRoute = resolveSessionKey;
    registerSlackReactionEvents({ ctx: harness.ctx });
    const handler = requireReactionHandler(
      harness.getHandler("reaction_added") as ReactionHandler | null,
      "added",
    );

    await handler({
      event: buildReactionEvent({ user: "U777", channel: "D123" }),
      body: {},
    });

    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "D123",
      channelType: "im",
      senderId: "U777",
    });
  });

  it("keeps enterprise reaction events isolated by listener workspace", async () => {
    const harness = createSlackSystemEventTestHarness();
    harness.ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_GRID",
      enterpriseId: "E_GRID",
    };
    const resolveChannelName = vi.fn(harness.ctx.resolveChannelName);
    const resolveUserName = vi.fn(harness.ctx.resolveUserName);
    const resolveSessionKey = vi.fn(
      (input: Parameters<typeof harness.ctx.resolveSlackSystemEventRoute>[0]) => ({
        agentId: "main",
        sessionKey: `session:${input.eventScope?.teamId ?? "workspace"}`,
      }),
    );
    harness.ctx.resolveChannelName = resolveChannelName;
    harness.ctx.resolveUserName = resolveUserName;
    harness.ctx.resolveSlackSystemEventRoute = resolveSessionKey;
    registerSlackReactionEvents({ ctx: harness.ctx });
    const handler = requireReactionHandler(
      harness.getHandler("reaction_added") as ReactionHandler | null,
      "added",
    );

    for (const teamId of ["T111", "T222"]) {
      await handler({
        event: buildReactionEvent(),
        ...buildEnterpriseListenerArgs(teamId),
      });
    }

    expect(reactionQueueMock).toHaveBeenNthCalledWith(1, expect.any(String), {
      sessionKey: "session:T111",
      contextKey: "slack:reaction:T111:added:D1:123.456:U1:thumbsup:Ev-reaction-T111",
    });
    expect(reactionQueueMock).toHaveBeenNthCalledWith(2, expect.any(String), {
      sessionKey: "session:T222",
      contextKey: "slack:reaction:T222:added:D1:123.456:U1:thumbsup:Ev-reaction-T222",
    });
    expect(resolveChannelName).toHaveBeenCalledWith(
      "D1",
      expect.objectContaining({ teamId: "T111" }),
    );
    expect(resolveChannelName).toHaveBeenCalledWith(
      "D1",
      expect.objectContaining({ teamId: "T222" }),
    );
    expect(resolveUserName).toHaveBeenCalledWith("U1", expect.objectContaining({ teamId: "T111" }));
  });

  it("allows an unscoped org user reaction policy across Enterprise workspaces", async () => {
    const harness = createSlackSystemEventTestHarness({
      dmPolicy: "open",
      reactionMode: "allowlist",
      reactionAllowlist: ["W01234567"],
    });
    harness.ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_GRID",
      enterpriseId: "E_GRID",
    };
    registerSlackReactionEvents({ ctx: harness.ctx });
    const handler = requireReactionHandler(
      harness.getHandler("reaction_added") as ReactionHandler | null,
      "added",
    );

    for (const teamId of ["T111", "T222"]) {
      await handler({
        event: buildReactionEvent({ user: "W01234567" }),
        ...buildEnterpriseListenerArgs(teamId),
      });
    }

    expect(reactionQueueMock).toHaveBeenCalledTimes(2);
  });

  it("rejects enterprise reaction events without validated listener scope", async () => {
    const trackEvent = vi.fn();
    const harness = createSlackSystemEventTestHarness();
    harness.ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_GRID",
      enterpriseId: "E_GRID",
    };
    registerSlackReactionEvents({ ctx: harness.ctx, trackEvent });
    const handler = requireReactionHandler(
      harness.getHandler("reaction_added") as ReactionHandler | null,
      "added",
    );

    await handler({
      event: buildReactionEvent(),
      body: { api_app_id: "A_GRID" },
      context: {
        isEnterpriseInstall: true,
        enterpriseId: "E_GRID",
      } as AllMiddlewareArgs["context"],
      client: { token: "listener" } as AllMiddlewareArgs["client"],
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(reactionQueueMock).not.toHaveBeenCalled();
  });

  // A reaction payload names the reacted message but no thread, so the routed
  // session is only correct when the handler resolves the message's thread root.
  describe("channel thread identity", () => {
    function createThreadRoutingHarness(params: {
      history: (args: unknown) => Promise<unknown>;
      replies?: (args: unknown) => Promise<unknown>;
      channelType?: "channel" | "im";
    }) {
      const harness = createSlackSystemEventTestHarness({
        dmPolicy: "open",
        channelType: params.channelType ?? "channel",
      });
      harness.ctx.cfg = { channels: { slack: { enabled: true } } };
      harness.ctx.accountId = "default";
      harness.ctx.channelsConfigKeys = [];
      harness.ctx.resolveSlackSystemEventRoute = createSlackSystemEventRouteResolver({
        cfg: harness.ctx.cfg,
        accountId: harness.ctx.accountId,
        getTeamId: () => harness.ctx.teamId,
        mainKey: "agent:main:main",
        threadInheritParent: false,
        recallSlackChannelType: () => params.channelType ?? "channel",
      });
      const replies = vi.fn(params.replies ?? (async () => ({ messages: [] })));
      (harness.ctx.app as unknown as { client?: unknown }).client = {
        conversations: { history: params.history, replies },
      };
      registerSlackReactionEvents({ ctx: harness.ctx });
      return {
        harness,
        replies,
        handler: requireReactionHandler(
          harness.getHandler("reaction_added") as ReactionHandler | null,
          "added",
        ),
      };
    }

    // Slack's conversations.history never returns thread replies, so a reaction on
    // a reply only resolves when the handler reads it through conversations.replies.
    it("routes a channel reaction to the reacted reply's thread session", async () => {
      const history = vi.fn().mockResolvedValue({ messages: [] });
      const replies = vi.fn().mockResolvedValue({
        messages: [{ ts: "123.456", thread_ts: "111.222" }],
      });
      const { harness, handler } = createThreadRoutingHarness({ history, replies });

      await handler({
        event: buildReactionEvent({ channel: "C1" }),
        body: { event_id: "Ev-thread-reaction" },
      });

      const threadSessionKey = harness.ctx.resolveSlackSystemEventRoute({
        channelId: "C1",
        channelType: "channel",
        senderId: "U1",
        threadTs: "111.222",
      }).sessionKey;
      const parentSessionKey = harness.ctx.resolveSlackSystemEventRoute({
        channelId: "C1",
        channelType: "channel",
        senderId: "U1",
      }).sessionKey;
      expect(threadSessionKey).not.toBe(parentSessionKey);
      expect(history).toHaveBeenCalledWith({
        channel: "C1",
        latest: "123.456",
        oldest: "123.456",
        inclusive: true,
        limit: 1,
      });
      expect(replies).toHaveBeenCalledWith({
        channel: "C1",
        ts: "123.456",
        latest: "123.456",
        oldest: "123.456",
        inclusive: true,
        limit: 1,
      });
      expect(reactionQueueMock).toHaveBeenCalledWith(expect.any(String), {
        sessionKey: threadSessionKey,
        contextKey: "slack:reaction:added:C1:123.456:U1:thumbsup:Ev-thread-reaction",
      });
    });

    it("keeps the parent channel session when the reacted reply has no thread", async () => {
      const history = vi.fn().mockResolvedValue({ messages: [] });
      const replies = vi.fn().mockResolvedValue({ messages: [{ ts: "123.456" }] });
      const { harness, handler } = createThreadRoutingHarness({ history, replies });

      await handler({
        event: buildReactionEvent({ channel: "C1" }),
        body: { event_id: "Ev-unthreaded-reaction" },
      });

      const parentSessionKey = harness.ctx.resolveSlackSystemEventRoute({
        channelId: "C1",
        channelType: "channel",
        senderId: "U1",
      }).sessionKey;
      expect(replies).toHaveBeenCalledTimes(1);
      expect(reactionQueueMock).toHaveBeenCalledWith(expect.any(String), {
        sessionKey: parentSessionKey,
        contextKey: "slack:reaction:added:C1:123.456:U1:thumbsup:Ev-unthreaded-reaction",
      });
    });

    it("keeps the parent channel session when the reacted message has no thread", async () => {
      const history = vi.fn().mockResolvedValue({ messages: [{ ts: "123.456" }] });
      const { harness, replies, handler } = createThreadRoutingHarness({ history });

      await handler({
        event: buildReactionEvent({ channel: "C1" }),
        body: { event_id: "Ev-parent-reaction" },
      });

      const parentSessionKey = harness.ctx.resolveSlackSystemEventRoute({
        channelId: "C1",
        channelType: "channel",
        senderId: "U1",
      }).sessionKey;
      expect(history).toHaveBeenCalledTimes(1);
      expect(replies).not.toHaveBeenCalled();
      expect(reactionQueueMock).toHaveBeenCalledWith(expect.any(String), {
        sessionKey: parentSessionKey,
        contextKey: "slack:reaction:added:C1:123.456:U1:thumbsup:Ev-parent-reaction",
      });
    });

    it("keeps a failed thread lookup on the parent channel session", async () => {
      const history = vi.fn().mockRejectedValue(new Error("missing_scope"));
      const { harness, handler } = createThreadRoutingHarness({ history });

      await handler({
        event: buildReactionEvent({ channel: "C1" }),
        body: { event_id: "Ev-failed-lookup" },
      });

      const parentSessionKey = harness.ctx.resolveSlackSystemEventRoute({
        channelId: "C1",
        channelType: "channel",
        senderId: "U1",
      }).sessionKey;
      expect(reactionQueueMock).toHaveBeenCalledWith(expect.any(String), {
        sessionKey: parentSessionKey,
        contextKey: "slack:reaction:added:C1:123.456:U1:thumbsup:Ev-failed-lookup",
      });
    });

    it("keeps the parent channel session when the reacted message is gone from both reads", async () => {
      const history = vi.fn().mockResolvedValue({ messages: [] });
      const replies = vi.fn().mockRejectedValue(new Error("thread_not_found"));
      const { harness, handler } = createThreadRoutingHarness({ history, replies });

      await handler({
        event: buildReactionEvent({ channel: "C1" }),
        body: { event_id: "Ev-missing-message" },
      });

      const parentSessionKey = harness.ctx.resolveSlackSystemEventRoute({
        channelId: "C1",
        channelType: "channel",
        senderId: "U1",
      }).sessionKey;
      expect(reactionQueueMock).toHaveBeenCalledWith(expect.any(String), {
        sessionKey: parentSessionKey,
        contextKey: "slack:reaction:added:C1:123.456:U1:thumbsup:Ev-missing-message",
      });
    });

    // Slack stamps a replied channel root with thread_ts === ts, and inbound routing
    // seeds such roots (mentions, implicit threading) into :thread:<root> alongside
    // their replies, so the reaction belongs to the root's own thread session.
    it("routes a reaction on a seeded channel root to the root's thread session", async () => {
      const history = vi.fn().mockResolvedValue({
        messages: [{ ts: "123.456", thread_ts: "123.456" }],
      });
      const { harness, replies, handler } = createThreadRoutingHarness({ history });

      await handler({
        event: buildReactionEvent({ channel: "C1" }),
        body: { event_id: "Ev-self-thread" },
      });

      const threadSessionKey = harness.ctx.resolveSlackSystemEventRoute({
        channelId: "C1",
        channelType: "channel",
        senderId: "U1",
        threadTs: "123.456",
      }).sessionKey;
      const parentSessionKey = harness.ctx.resolveSlackSystemEventRoute({
        channelId: "C1",
        channelType: "channel",
        senderId: "U1",
      }).sessionKey;
      expect(threadSessionKey).not.toBe(parentSessionKey);
      expect(history).toHaveBeenCalledTimes(1);
      expect(replies).not.toHaveBeenCalled();
      expect(reactionQueueMock).toHaveBeenCalledWith(expect.any(String), {
        sessionKey: threadSessionKey,
        contextKey: "slack:reaction:added:C1:123.456:U1:thumbsup:Ev-self-thread",
      });
    });

    it("does not look up a thread for direct-message reactions", async () => {
      const history = vi.fn().mockResolvedValue({
        messages: [{ ts: "123.456", thread_ts: "111.222" }],
      });
      const { harness, handler } = createThreadRoutingHarness({ history, channelType: "im" });

      await handler({
        event: buildReactionEvent(),
        body: { event_id: "Ev-dm-reaction" },
      });

      const dmSessionKey = harness.ctx.resolveSlackSystemEventRoute({
        channelId: "D1",
        channelType: "im",
        senderId: "U1",
      }).sessionKey;
      expect(history).not.toHaveBeenCalled();
      expect(reactionQueueMock).toHaveBeenCalledWith(expect.any(String), {
        sessionKey: dmSessionKey,
        contextKey: "slack:reaction:added:D1:123.456:U1:thumbsup:Ev-dm-reaction",
      });
    });
  });
});
