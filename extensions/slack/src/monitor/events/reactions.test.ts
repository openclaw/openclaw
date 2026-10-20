import type { AllMiddlewareArgs } from "@slack/bolt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlackCommonEvents } from "../events.js";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventTestOverrides,
} from "./system-event-test-harness.js";

const reactionQueueMock = vi.hoisted(() => vi.fn());

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

function createReactionHarness(overrides?: SlackSystemEventTestOverrides, enterprise = false) {
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
  const handler = harness.getHandler("reaction_added");
  if (!handler) {
    throw new Error("expected Slack added reaction handler");
  }
  return { ...harness, handler, trackEvent };
}

describe("Slack reactions events", () => {
  beforeEach(() => {
    reactionQueueMock.mockClear();
  });

  const cases: Array<{
    name: string;
    overrides: SlackSystemEventTestOverrides;
    event?: Record<string, unknown>;
    expectedCalls: number;
  }> = [
    {
      name: "blocks channel reaction events for users outside channel users allowlist",
      overrides: { channelType: "channel", channelUsers: ["U_OWNER"] },
      event: buildReactionEvent({ channel: "C1", user: "U_ATTACKER" }),
      expectedCalls: 0,
    },
    {
      name: "blocks reactions when reaction notifications are off",
      overrides: { reactionMode: "off" },
      expectedCalls: 0,
    },
    {
      name: "blocks own-mode reactions on messages not authored by the bot",
      overrides: { reactionMode: "own" },
      event: { ...buildReactionEvent(), item_user: "U_OTHER" },
      expectedCalls: 0,
    },
    {
      name: "allows own-mode reactions on messages authored by the bot",
      overrides: { reactionMode: "own" },
      event: { ...buildReactionEvent(), item_user: "U_BOT" },
      expectedCalls: 1,
    },
    {
      name: "blocks reactions from senders outside the reaction allowlist",
      overrides: { reactionMode: "allowlist", reactionAllowlist: ["U2"] },
      expectedCalls: 0,
    },
    {
      name: "blocks allowlist-mode reactions when the reaction allowlist is empty",
      overrides: { reactionMode: "allowlist", reactionAllowlist: [] },
      expectedCalls: 0,
    },
    {
      name: "allows reactions from senders inside the reaction allowlist",
      overrides: { reactionMode: "allowlist", reactionAllowlist: ["U1"] },
      expectedCalls: 1,
    },
  ];

  it.each(cases)("$name", async ({ overrides, event, expectedCalls }) => {
    await createReactionHarness(overrides).handler({
      event: event ?? buildReactionEvent(),
      body: { event_id: "Ev-reaction-default" },
    });
    expect(reactionQueueMock).toHaveBeenCalledTimes(expectedCalls);
  });

  it("does not track mismatched events", async () => {
    const { ctx, handler, trackEvent } = createReactionHarness();
    ctx.shouldDropMismatchedSlackEvent = () => true;
    await handler({
      event: buildReactionEvent(),
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("keeps enterprise reaction events isolated by listener workspace", async () => {
    const { ctx, handler, trackEvent } = createReactionHarness(undefined, true);
    const resolveChannelName = vi.spyOn(ctx, "resolveChannelName");
    const resolveUserName = vi.spyOn(ctx, "resolveUserName");
    vi.spyOn(ctx, "resolveSlackSystemEventRoute").mockImplementation(async (input) => ({
      agentId: "main",
      sessionKey: `session:${input.eventScope?.teamId ?? "workspace"}`,
    }));

    for (const [index, teamId] of ["T111", "T222"].entries()) {
      await handler({
        event: buildReactionEvent(),
        ...buildEnterpriseListenerArgs(teamId),
      });
      expect(reactionQueueMock).toHaveBeenNthCalledWith(index + 1, expect.any(String), {
        sessionKey: `session:${teamId}`,
        contextKey: `slack:reaction:${teamId}:added:D1:123.456:U1:thumbsup:Ev-reaction-${teamId}`,
      });
      expect(resolveChannelName).toHaveBeenCalledWith("D1", expect.objectContaining({ teamId }));
    }
    expect(trackEvent).toHaveBeenCalledTimes(2);
    expect(resolveUserName).toHaveBeenCalledWith("U1", expect.objectContaining({ teamId: "T111" }));
  });

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

  it("rejects enterprise reaction events without validated listener scope", async () => {
    const { handler, trackEvent } = createReactionHarness(undefined, true);

    await handler({
      event: buildReactionEvent(),
      ...buildEnterpriseListenerArgs(),
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(reactionQueueMock).not.toHaveBeenCalled();
  });
});
