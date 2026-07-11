// Slack tests cover home plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveSlackEffectiveAllowFromMock = vi.hoisted(() => vi.fn());
const issuePairingChallengeMock = vi.hoisted(() => vi.fn());

let buildSlackHomeView: typeof import("./home.js").buildSlackHomeView;
let handleSlackHomeBlockAction: typeof import("./home.js").handleSlackHomeBlockAction;
let slackHomeGroupDmActionId: typeof import("./home.js").SLACK_HOME_GROUP_DM_ACTION_ID;
let registerSlackHomeEvents: typeof import("./home.js").registerSlackHomeEvents;
let createSlackSystemEventTestHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;

vi.mock("../auth.js", () => ({
  resolveSlackEffectiveAllowFrom: (...args: unknown[]) =>
    resolveSlackEffectiveAllowFromMock(...args),
}));

vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingChallengeIssuer: () => issuePairingChallengeMock,
}));

type HomeHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

function createHomeContext(params?: {
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
  groupDmEnabled?: boolean;
  groupDmChannels?: string[];
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  alreadyOpen?: boolean;
}) {
  const harness = createSlackSystemEventTestHarness();
  const publish = vi.fn().mockResolvedValue({ ok: true });
  const open = vi.fn().mockResolvedValue({
    ok: true,
    already_open: params?.alreadyOpen ?? false,
    channel: { id: "G123" },
  });
  const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: "100.200" });
  if (params?.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  harness.ctx.botToken = "xoxb-test";
  harness.ctx.groupDmEnabled = params?.groupDmEnabled ?? false;
  harness.ctx.groupDmChannels = params?.groupDmChannels ?? [];
  harness.ctx.dmPolicy = params?.dmPolicy ?? "open";
  (
    harness.ctx.app as unknown as {
      client: {
        views: { publish: typeof publish };
        conversations: { open: typeof open };
        chat: { postMessage: typeof postMessage };
      };
    }
  ).client = {
    views: { publish },
    conversations: { open },
    chat: { postMessage },
  };
  registerSlackHomeEvents({ ctx: harness.ctx, trackEvent: params?.trackEvent });
  return {
    ctx: harness.ctx,
    publish,
    open,
    postMessage,
    getHomeHandler: () => harness.getHandler("app_home_opened") as HomeHandler | null,
  };
}

function buildGroupDmActionBody(selectedUsers: string[]) {
  return {
    user: { id: "U_ACTOR" },
    view: { callback_id: "openclaw:home" },
    state: {
      values: {
        "openclaw:home:group-members": {
          "openclaw:home:group-members": {
            type: "multi_users_select",
            selected_users: selectedUsers,
          },
        },
      },
    },
  };
}

describe("registerSlackHomeEvents", () => {
  beforeAll(async () => {
    ({
      buildSlackHomeView,
      handleSlackHomeBlockAction,
      registerSlackHomeEvents,
      SLACK_HOME_GROUP_DM_ACTION_ID: slackHomeGroupDmActionId,
    } = await import("./home.js"));
    ({ createSlackSystemEventTestHarness } = await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSlackEffectiveAllowFromMock.mockResolvedValue(["*"]);
    issuePairingChallengeMock.mockImplementation(
      async (params: { sendPairingReply: (text: string) => Promise<void> }) => {
        await params.sendPairingReply("Pairing approval required. Code: `PAIR1234`");
      },
    );
  });

  it("publishes the default Home tab view for app_home_opened", async () => {
    const trackEvent = vi.fn();
    const { publish, getHomeHandler } = createHomeContext({ trackEvent });
    const handler = getHomeHandler();
    if (!handler) {
      throw new Error("expected Slack Home handler");
    }

    await handler({
      event: {
        type: "app_home_opened",
        user: "U123",
        channel: "D123",
        tab: "home",
        event_ts: "123.456",
      },
      body: { api_app_id: "A1" },
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      token: "xoxb-test",
      user_id: "U123",
      view: buildSlackHomeView(),
    });
  });

  it("does not publish when Slack reports the Messages tab", async () => {
    const trackEvent = vi.fn();
    const { publish, getHomeHandler } = createHomeContext({ trackEvent });

    await getHomeHandler()!({
      event: {
        type: "app_home_opened",
        user: "U123",
        channel: "D123",
        tab: "messages",
      },
      body: {},
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not track or publish mismatched events", async () => {
    const trackEvent = vi.fn();
    const { publish, getHomeHandler } = createHomeContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });

    await getHomeHandler()!({
      event: {
        type: "app_home_opened",
        user: "U123",
        tab: "home",
      },
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("shows the group DM picker only when new group DMs are allowed", async () => {
    const enabled = createHomeContext({ groupDmEnabled: true });
    const restricted = createHomeContext({
      groupDmEnabled: true,
      groupDmChannels: ["G_ALLOWED"],
    });

    await enabled.getHomeHandler()!({
      event: { type: "app_home_opened", user: "U123", tab: "home" },
      body: {},
    });
    await restricted.getHomeHandler()!({
      event: { type: "app_home_opened", user: "U123", tab: "home" },
      body: {},
    });

    const enabledView = enabled.publish.mock.calls[0]?.[0]?.view;
    const restrictedView = restricted.publish.mock.calls[0]?.[0]?.view;
    expect(enabledView?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "input",
          block_id: "openclaw:home:group-members",
          dispatch_action: false,
          element: expect.objectContaining({
            type: "multi_users_select",
            action_id: "openclaw:home:group-members",
            max_selected_items: 7,
          }),
        }),
        expect.objectContaining({
          type: "actions",
          elements: [
            expect.objectContaining({
              action_id: slackHomeGroupDmActionId,
              text: expect.objectContaining({ text: "Open group DM" }),
            }),
          ],
        }),
      ]),
    );
    expect(JSON.stringify(restrictedView)).not.toContain(slackHomeGroupDmActionId);
  });

  it("opens a bot-inclusive group DM from the Home picker", async () => {
    const { ctx, open, postMessage, publish } = createHomeContext({ groupDmEnabled: true });

    const handled = await handleSlackHomeBlockAction({
      ctx,
      actionId: slackHomeGroupDmActionId,
      body: buildGroupDmActionBody(["U2", "U_ACTOR", "U_BOT", "U2", "U3"]),
    });

    expect(handled).toBe(true);
    expect(resolveSlackEffectiveAllowFromMock).toHaveBeenCalledWith(ctx, {
      includePairingStore: true,
    });
    expect(open).toHaveBeenCalledWith({
      token: "xoxb-test",
      users: "U_ACTOR,U2,U3",
      return_im: true,
    });
    expect(postMessage).toHaveBeenCalledWith({
      token: "xoxb-test",
      channel: "G123",
      text: "OpenClaw is ready in this group DM. Send a message here to start.",
    });
    expect(JSON.stringify(publish.mock.calls.at(-1)?.[0]?.view)).toContain(
      "https://slack.com/app_redirect?team=T_TEST&channel=G123",
    );
  });

  it("does not post another starter message when Slack resumes the same group DM", async () => {
    const { ctx, postMessage } = createHomeContext({
      groupDmEnabled: true,
      alreadyOpen: true,
    });

    await handleSlackHomeBlockAction({
      ctx,
      actionId: slackHomeGroupDmActionId,
      body: buildGroupDmActionBody(["U2"]),
    });

    expect(postMessage).not.toHaveBeenCalled();
  });

  it("requires another human participant", async () => {
    const { ctx, open, publish } = createHomeContext({ groupDmEnabled: true });

    await handleSlackHomeBlockAction({
      ctx,
      actionId: slackHomeGroupDmActionId,
      body: buildGroupDmActionBody(["U_ACTOR", "U_BOT"]),
    });

    expect(open).not.toHaveBeenCalled();
    expect(JSON.stringify(publish.mock.calls.at(-1)?.[0]?.view)).toContain(
      "Choose at least one other person.",
    );
  });

  it("requires pairing before opening the group DM", async () => {
    resolveSlackEffectiveAllowFromMock.mockResolvedValueOnce([]);
    const { ctx, open, publish } = createHomeContext({
      groupDmEnabled: true,
      dmPolicy: "pairing",
    });

    await handleSlackHomeBlockAction({
      ctx,
      actionId: slackHomeGroupDmActionId,
      body: buildGroupDmActionBody(["U2"]),
    });

    expect(open).not.toHaveBeenCalled();
    expect(issuePairingChallengeMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(publish.mock.calls.at(-1)?.[0]?.view)).toContain(
      "Pairing approval required. Code: `PAIR1234`",
    );
  });

  it("keeps the picker retryable when Slack cannot open the group DM", async () => {
    const { ctx, open, publish } = createHomeContext({ groupDmEnabled: true });
    open.mockRejectedValueOnce(new Error("missing_scope"));

    await handleSlackHomeBlockAction({
      ctx,
      actionId: slackHomeGroupDmActionId,
      body: buildGroupDmActionBody(["U2"]),
    });

    const view = publish.mock.calls.at(-1)?.[0]?.view;
    expect(JSON.stringify(view)).toContain("Slack could not open that group DM.");
    expect(JSON.stringify(view)).toContain('"initial_users":["U2"]');
  });

  it("ignores the reserved action id outside the OpenClaw Home view", async () => {
    const { ctx, open } = createHomeContext({ groupDmEnabled: true });

    const handled = await handleSlackHomeBlockAction({
      ctx,
      actionId: slackHomeGroupDmActionId,
      body: {
        ...buildGroupDmActionBody(["U2"]),
        view: { callback_id: "another-app-home" },
      },
    });

    expect(handled).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
