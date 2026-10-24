import type { AllMiddlewareArgs } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlackCommonEvents } from "../events.js";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventTestOverrides,
} from "./system-event-test-harness.js";

const reactionQueueMock = vi.hoisted(() => vi.fn());
const reportJoinMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-join-intro-runtime")>()),
  reportChannelRoomJoin: reportJoinMock,
}));
type JoinRequest = Parameters<
  typeof import("openclaw/plugin-sdk/channel-join-intro-runtime").reportChannelRoomJoin
>[0];
const joinRequest = () => reportJoinMock.mock.calls[0]?.[0] as JoinRequest;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => reactionQueueMock(text, { ...options, sessionKey: route.sessionKey }),
}));

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

function buildEnterpriseListenerArgs(teamId?: string) {
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

function createReactionHarness(
  overrides?: SlackSystemEventTestOverrides,
  enterprise = false,
  eventName = "reaction_added",
) {
  const harness = createSlackSystemEventTestHarness(overrides);
  const trackEvent = vi.fn();
  if (enterprise) {
    harness.ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_GRID",
      enterpriseId: "E_GRID",
    };
  }
  registerSlackCommonEvents({
    ctx: harness.ctx,
    handleSlackMessage: vi.fn(),
    trackEvent,
  });
  const handler = harness.getHandler(eventName);
  if (!handler) {
    throw new Error(`expected Slack ${eventName} handler`);
  }
  return {
    ...harness,
    handler,
    trackEvent,
    emit: (event: Record<string, unknown>, eventId = "Ev-member-default") =>
      handler({ event, body: { event_id: eventId } }),
  };
}

function makeMemberEvent(overrides?: { channel?: string; user?: string }) {
  return {
    type: "member_joined_channel",
    user: overrides?.user ?? "U1",
    channel: overrides?.channel ?? "D1",
    event_ts: "123.456",
  };
}
function createMemberHarness(overrides?: SlackSystemEventTestOverrides) {
  return createReactionHarness(overrides, false, "member_joined_channel");
}

const commonEvents = [
  {
    kind: "member",
    eventName: "member_joined_channel",
    event: makeMemberEvent(),
    contextKey: (teamId: string) => `slack:member:${teamId}:joined:D1:U1:Ev-member-${teamId}`,
  },
  {
    kind: "reaction",
    eventName: "reaction_added",
    event: buildReactionEvent(),
    contextKey: (teamId: string) =>
      `slack:reaction:${teamId}:added:D1:123.456:U1:thumbsup:Ev-reaction-${teamId}`,
  },
  {
    kind: "pin",
    eventName: "pin_added",
    event: {
      type: "pin_added",
      user: "U1",
      channel_id: "D1",
      event_ts: "123.456",
      item: { type: "message", message: { ts: "123.456" } },
    },
    contextKey: (teamId: string) => `slack:pin:${teamId}:added:D1:123.456:Ev-pin-${teamId}`,
  },
] as const;

describe("Slack common events", () => {
  beforeEach(() => {
    reactionQueueMock.mockClear();
    reportJoinMock.mockReset().mockResolvedValue({ kind: "posted" });
  });

  it.each<[string, SlackSystemEventTestOverrides, number, Record<string, unknown>?]>([
    [
      "channel user denied",
      { channelType: "channel", channelUsers: ["U_OWNER"] },
      0,
      buildReactionEvent({ channel: "C1", user: "U_ATTACKER" }),
    ],
    ["notifications off", { reactionMode: "off" }, 0],
    [
      "other author's message",
      { reactionMode: "own" },
      0,
      { ...buildReactionEvent(), item_user: "U_OTHER" },
    ],
    ["bot's message", { reactionMode: "own" }, 1, { ...buildReactionEvent(), item_user: "U_BOT" }],
    ["sender denied", { reactionMode: "allowlist", reactionAllowlist: ["U2"] }, 0],
    ["empty allowlist", { reactionMode: "allowlist", reactionAllowlist: [] }, 0],
    ["sender allowed", { reactionMode: "allowlist", reactionAllowlist: ["U1"] }, 1],
  ])("reaction policy: %s", async (_name, overrides, expectedCalls, event) => {
    await createReactionHarness(overrides).handler({
      event: event ?? buildReactionEvent(),
      body: { event_id: "Ev-reaction-default" },
    });
    expect(reactionQueueMock).toHaveBeenCalledTimes(expectedCalls);
  });

  it.each<SlackSystemEventTestOverrides>([
    { dmPolicy: "disabled" },
    { dmPolicy: "allowlist", allowFrom: ["U2"] },
  ])("blocks unauthorized DM pins: $dmPolicy", async (overrides) => {
    await createReactionHarness(overrides, false, "pin_added").handler({
      event: commonEvents[2].event,
      body: { event_id: "Ev-pin-default" },
    });
    expect(reactionQueueMock).not.toHaveBeenCalled();
  });

  it.each(commonEvents)("does not track mismatched $kind events", async ({ eventName, event }) => {
    const { ctx, handler, trackEvent } = createReactionHarness(undefined, false, eventName);
    ctx.shouldDropMismatchedSlackEvent = () => true;
    await handler({
      event,
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it.each(commonEvents)(
    "keeps enterprise $kind events isolated by listener workspace",
    async ({ kind, eventName, event, contextKey }) => {
      const { ctx, handler, trackEvent } = createReactionHarness(undefined, true, eventName);
      const resolveChannelName = vi.spyOn(ctx, "resolveChannelName");
      const resolveUserName = vi.spyOn(ctx, "resolveUserName");
      vi.spyOn(ctx, "resolveSlackSystemEventRoute").mockImplementation(async (input) => ({
        agentId: "main",
        sessionKey: `session:${input.eventScope?.teamId ?? "workspace"}`,
      }));

      for (const [index, teamId] of ["T111", "T222"].entries()) {
        await handler({
          event,
          ...buildEnterpriseListenerArgs(teamId),
          body: { api_app_id: "A_GRID", event_id: `Ev-${kind}-${teamId}` },
        });
        expect(reactionQueueMock).toHaveBeenNthCalledWith(index + 1, expect.any(String), {
          sessionKey: `session:${teamId}`,
          contextKey: contextKey(teamId),
        });
        expect(resolveChannelName).toHaveBeenCalledWith("D1", expect.objectContaining({ teamId }));
      }
      expect(trackEvent).toHaveBeenCalledTimes(2);
      expect(resolveUserName).toHaveBeenCalledWith(
        "U1",
        expect.objectContaining({ teamId: "T111" }),
      );
      expect(resolveUserName).toHaveBeenCalledWith(
        "U1",
        expect.objectContaining({ teamId: "T222" }),
      );
    },
  );

  it("allows an unscoped org user reaction policy across Enterprise workspaces", async () => {
    const { handler } = createReactionHarness(
      {
        reactionMode: "allowlist",
        reactionAllowlist: ["W01234567"],
      },
      true,
    );

    for (const teamId of ["T111", "T222"]) {
      await handler({
        event: buildReactionEvent({ user: "W01234567" }),
        ...buildEnterpriseListenerArgs(teamId),
      });
    }

    expect(reactionQueueMock).toHaveBeenCalledTimes(2);
  });

  it.each(commonEvents)(
    "rejects enterprise $kind events without validated listener scope",
    async ({ eventName, event }) => {
      const { handler, trackEvent } = createReactionHarness(undefined, true, eventName);

      await handler({
        event,
        ...buildEnterpriseListenerArgs(),
      });

      expect(trackEvent).not.toHaveBeenCalled();
      expect(reactionQueueMock).not.toHaveBeenCalled();
    },
  );
  it("blocks channel member events for users outside channel users allowlist", async () => {
    const { emit } = createMemberHarness({ channelType: "channel", channelUsers: ["U_OWNER"] });
    await emit(makeMemberEvent({ channel: "C1", user: "U_ATTACKER" }));
    expect(reactionQueueMock).not.toHaveBeenCalled();
  });

  it("introduces the joined bot in an allowed room despite sender and mention requirements", async () => {
    const { ctx, emit } = createMemberHarness({
      channelType: "channel",
      channelUsers: ["U_OWNER"],
    });
    ctx.cfg = { channels: { slack: { groupPolicy: "open" } } };
    ctx.resolveChannelName = vi.fn(async () => ({
      name: "deploys",
      type: "channel" as const,
      purpose: "Coordinate production deployments",
      topic: "Current release: 42",
    }));
    ctx.resolveUserName = vi.fn(async () => ({ name: "Morgan" }));
    ctx.app.client = new WebClient("xoxb-test");
    const readHistory = vi.spyOn(ctx.app.client.conversations, "history").mockResolvedValue({
      ok: true,
      messages: [
        { user: "U_NEW", text: "Release 42 is ready" },
        { user: "U_OLD", text: "Watch the rollback checklist" },
      ],
    });

    await emit(
      { ...makeMemberEvent({ channel: "C1", user: "U_BOT" }), inviter: "U_OWNER" },
      "Ev-self-join",
    );

    expect(reportJoinMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "default",
        conversationId: "C1",
        deliverTo: "channel:C1",
        inviterLabel: "Morgan",
        roomAllowed: true,
        route: { agentId: "main", sessionKey: "agent:main:main" },
      }),
    );
    await expect(joinRequest().resolveRoomContext({ messageLimit: 30 })).resolves.toEqual({
      title: "#deploys",
      purpose: "Coordinate production deployments\nCurrent release: 42",
      recentMessages: [
        { sender: "U_OLD", text: "Watch the rollback checklist" },
        { sender: "U_NEW", text: "Release 42 is ready" },
      ],
    });
    expect(readHistory).toHaveBeenCalledWith({
      channel: "C1",
      limit: 30,
      latest: undefined,
      oldest: undefined,
    });
    expect(reactionQueueMock).not.toHaveBeenCalled();
  });

  it("reports a denied bot self-join using conversation policy without applying sender policy", async () => {
    const { ctx, emit } = createMemberHarness({
      channelType: "channel",
      channelUsers: ["U_OWNER"],
    });
    ctx.cfg = { channels: { slack: { groupPolicy: "allowlist" } } };
    ctx.isChannelAllowed = vi.fn(() => false);

    await emit(makeMemberEvent({ channel: "C1", user: "U_BOT" }), "Ev-self-denied");

    expect(ctx.isChannelAllowed).toHaveBeenCalledWith({
      teamId: "T_TEST",
      channelId: "C1",
      channelName: "general",
      channelType: "channel",
    });
    expect(reportJoinMock).toHaveBeenCalledWith(expect.objectContaining({ roomAllowed: false }));
    expect(reactionQueueMock).not.toHaveBeenCalled();
  });

  it("keeps room metadata when Slack denies the joined room's message history", async () => {
    const { ctx, emit } = createMemberHarness({ channelType: "group" });
    ctx.cfg = { channels: { slack: { groupPolicy: "open" } } };
    ctx.app.client = new WebClient("xoxb-test");
    vi.spyOn(ctx.app.client.conversations, "history").mockRejectedValue(new Error("missing_scope"));

    await emit(makeMemberEvent({ channel: "G1", user: "U_BOT" }), "Ev-self-private");

    await expect(joinRequest().resolveRoomContext({ messageLimit: 30 })).resolves.toEqual({
      title: "#general",
      purpose: undefined,
    });
  });

  it.each([
    { name: "direct message", channel: "D1", type: "im" as const, nativeType: "D" },
    { name: "group DM", channel: "G1", type: "mpim" as const, nativeType: "G" },
    { name: "C-prefixed group DM", channel: "C1", type: "mpim" as const, nativeType: "C" },
    { name: "unresolved room", channel: "G1", type: undefined, nativeType: "G" },
  ])("does not introduce the bot into a $name", async ({ channel, type, nativeType }) => {
    const { ctx, emit } = createMemberHarness();
    ctx.resolveChannelName = vi.fn(async () => ({ type }));
    ctx.runtime.log = vi.fn();

    await emit({
      ...makeMemberEvent({ channel, user: "U_BOT" }),
      channel_type: nativeType,
    });

    expect(reportJoinMock).not.toHaveBeenCalled();
    if (type === undefined) {
      expect(ctx.runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("reason=channel-type-unavailable"),
      );
    }
  });

  it("qualifies enterprise introduction claims and delivery by listener workspace", async () => {
    const { ctx, handler } = createReactionHarness(
      { channelType: "channel" },
      true,
      "member_joined_channel",
    );
    ctx.cfg = { channels: { slack: { groupPolicy: "open" } } };
    vi.spyOn(ctx, "resolveSlackSystemEventRoute").mockImplementation(async (input) => ({
      agentId: "main",
      sessionKey: `session:${input.eventScope?.teamId}`,
    }));

    for (const teamId of ["T111", "T222"]) {
      await handler({
        event: makeMemberEvent({ channel: "C1", user: "U_BOT" }),
        ...buildEnterpriseListenerArgs(teamId),
      });
    }

    expect(reportJoinMock.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        conversationId: "team:T111:C1",
        deliverTo: "team:T111:channel:C1",
        route: { agentId: "main", sessionKey: "session:T111" },
      }),
      expect.objectContaining({
        conversationId: "team:T222:C1",
        deliverTo: "team:T222:channel:C1",
        route: { agentId: "main", sessionKey: "session:T222" },
      }),
    ]);
    expect(reactionQueueMock).not.toHaveBeenCalled();
  });

  it("uses the stable user ID when the post-auth name lookup fails", async () => {
    const { ctx, emit } = createMemberHarness({
      channelType: "channel",
      channelUsers: ["U1"],
    });
    const resolveUserName = vi.fn(async () => ({ error: new Error("users.info failed") }));
    ctx.resolveUserName = resolveUserName;

    await emit(makeMemberEvent({ channel: "C1", user: "U1" }), "Ev-member-id-fallback");

    expect(resolveUserName).toHaveBeenCalledOnce();
    expect(reactionQueueMock).toHaveBeenCalledWith(
      "Slack: U1 joined #general.",
      expect.objectContaining({
        contextKey: "slack:member:joined:C1:U1:Ev-member-id-fallback",
      }),
    );
  });
});
