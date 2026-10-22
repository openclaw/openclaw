import type { AllMiddlewareArgs } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlackMemberEvents } from "./members.js";
import {
  createSlackSystemEventTestHarness as initSlackHarness,
  type SlackSystemEventTestOverrides as MemberOverrides,
} from "./system-event-test-harness.js";

const memberMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  reportJoin: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", () => ({
  reportChannelRoomJoin: memberMocks.reportJoin,
}));

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => memberMocks.enqueue(text, { ...options, sessionKey: route.sessionKey }),
}));

function makeMemberEvent(overrides?: { channel?: string; user?: string }) {
  return {
    type: "member_joined_channel",
    user: overrides?.user ?? "U1",
    channel: overrides?.channel ?? "D1",
    event_ts: "123.456",
  };
}

function createMemberHarness(overrides?: MemberOverrides) {
  const harness = initSlackHarness(overrides);
  const trackEvent = vi.fn();
  registerSlackMemberEvents({ ctx: harness.ctx, trackEvent });
  const handler = harness.getHandler("member_joined_channel");
  if (!handler) {
    throw new Error("expected Slack member joined handler");
  }
  return {
    ...harness,
    handler,
    trackEvent,
    emit: (event: Record<string, unknown>, eventId = "Ev-member-default") =>
      handler({ event, body: { event_id: eventId } }),
  };
}

type JoinRequest = Parameters<
  typeof import("openclaw/plugin-sdk/channel-join-intro-runtime").reportChannelRoomJoin
>[0];
const joinRequest = () => memberMocks.reportJoin.mock.calls[0]?.[0] as JoinRequest;

describe("registerSlackMemberEvents", () => {
  beforeEach(() => {
    memberMocks.enqueue.mockClear();
    memberMocks.reportJoin.mockReset().mockResolvedValue({ kind: "posted" });
  });

  it("blocks channel member events for users outside channel users allowlist", async () => {
    const { emit } = createMemberHarness({ channelType: "channel", channelUsers: ["U_OWNER"] });
    await emit(makeMemberEvent({ channel: "C1", user: "U_ATTACKER" }));
    expect(memberMocks.enqueue).not.toHaveBeenCalled();
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

    expect(memberMocks.reportJoin).toHaveBeenCalledExactlyOnceWith(
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
    expect(memberMocks.enqueue).not.toHaveBeenCalled();
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
    expect(memberMocks.reportJoin).toHaveBeenCalledWith(
      expect.objectContaining({ roomAllowed: false }),
    );
    expect(memberMocks.enqueue).not.toHaveBeenCalled();
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

  it("never introduces the bot into a direct-message conversation", async () => {
    await createMemberHarness().emit(makeMemberEvent({ channel: "D1", user: "U_BOT" }));

    expect(memberMocks.reportJoin).not.toHaveBeenCalled();
  });

  it("does not track mismatched events", async () => {
    const { ctx, handler, trackEvent } = createMemberHarness();
    ctx.shouldDropMismatchedSlackEvent = () => true;
    await handler({
      event: makeMemberEvent(),
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
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
    expect(memberMocks.enqueue).toHaveBeenCalledWith(
      "Slack: U1 joined #general.",
      expect.objectContaining({
        contextKey: "slack:member:joined:C1:U1:Ev-member-id-fallback",
      }),
    );
  });

  it("keeps enterprise member events isolated by listener workspace", async () => {
    const { ctx, handler, trackEvent } = createMemberHarness();
    ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_GRID",
      enterpriseId: "E_GRID",
    };
    const resolveChannelName = vi.spyOn(ctx, "resolveChannelName");
    const resolveUserName = vi.spyOn(ctx, "resolveUserName");
    vi.spyOn(ctx, "resolveSlackSystemEventRoute").mockImplementation(async (input) => ({
      agentId: "main",
      sessionKey: `session:${input.eventScope?.teamId ?? "workspace"}`,
    }));

    for (const [index, teamId] of ["T111", "T222"].entries()) {
      await handler({
        event: makeMemberEvent(),
        body: { api_app_id: "A_GRID", event_id: `Ev-member-${teamId}` },
        context: {
          isEnterpriseInstall: true,
          enterpriseId: "E_GRID",
          teamId,
        } as AllMiddlewareArgs["context"],
        client: { token: `listener-${teamId}` } as AllMiddlewareArgs["client"],
      });
      expect(memberMocks.enqueue).toHaveBeenNthCalledWith(index + 1, expect.any(String), {
        sessionKey: `session:${teamId}`,
        contextKey: `slack:member:${teamId}:joined:D1:U1:Ev-member-${teamId}`,
      });
    }
    expect(trackEvent).toHaveBeenCalledTimes(2);
    expect(resolveChannelName).toHaveBeenCalledWith(
      "D1",
      expect.objectContaining({ teamId: "T111" }),
    );
    expect(resolveUserName).toHaveBeenCalledWith("U1", expect.objectContaining({ teamId: "T222" }));
  });

  it("rejects enterprise member events without validated listener scope", async () => {
    const { ctx, handler, trackEvent } = createMemberHarness();
    ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_GRID",
      enterpriseId: "E_GRID",
    };

    await handler({
      event: makeMemberEvent(),
      body: { api_app_id: "A_GRID" },
      context: {
        isEnterpriseInstall: true,
        enterpriseId: "E_GRID",
      } as AllMiddlewareArgs["context"],
      client: { token: "listener" } as AllMiddlewareArgs["client"],
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(memberMocks.enqueue).not.toHaveBeenCalled();
  });
});
