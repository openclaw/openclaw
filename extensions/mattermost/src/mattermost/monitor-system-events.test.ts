import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { MattermostConfig } from "../types.js";
import { createMattermostSystemEventHandler } from "./monitor-system-events.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import {
  createLoopbackMonitorContext,
  LOOPBACK_CHANNEL_ID as CHANNEL_ID,
  LOOPBACK_SESSION_KEY as SESSION_KEY,
  withLoopbackMattermost,
} from "./monitor.loopback.test-support.js";

const BOT_USER_ID = "bot-user";

const state = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  reportChannelRoomJoin: vi.fn<typeof reportChannelRoomJoin>(async () => ({ kind: "posted" })),
}));

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-join-intro-runtime")>()),
  reportChannelRoomJoin: state.reportChannelRoomJoin,
}));
afterEach(() => {
  state.enqueueSystemEvent.mockClear();
  state.reportChannelRoomJoin.mockClear();
});
// The owner's durable join claim opens the state database; this file runs in the worker project.
afterAll(() => closeOpenClawStateDatabaseForTest());

async function reportThroughOwner() {
  const { reportChannelRoomJoin: ownerReportChannelRoomJoin } = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-join-intro-runtime")
  >("openclaw/plugin-sdk/channel-join-intro-runtime");
  state.reportChannelRoomJoin.mockImplementationOnce(ownerReportChannelRoomJoin);
}

const POSTS_PATH = `/api/v4/channels/${CHANNEL_ID}/posts?per_page=100&skipFetchThreads=true`;

const payloads: Record<string, unknown> = {
  [`/api/v4/channels/${CHANNEL_ID}`]: {
    id: CHANNEL_ID,
    name: "deploys",
    display_name: "Deploys",
    type: "O",
    purpose: "Ship things",
    header: "Deploy window: weekdays",
  },
  "/api/v4/users/user-1": { id: "user-1", username: "alice", update_at: 1 },
  "/api/v4/users/user-2": { id: "user-2", username: "bob", update_at: 1 },
  [POSTS_PATH]: {
    order: ["post-new", "post-old", "post-system"],
    posts: {
      "post-new": { id: "post-new", user_id: "user-2", message: "second" },
      "post-old": { id: "post-old", user_id: "user-1", message: "first" },
      "post-system": { id: "post-system", user_id: "user-1", message: "x", type: "system_join" },
    },
  },
};

type MonitorOptions = Pick<
  Parameters<typeof createLoopbackMonitorContext>[0],
  "config" | "current"
> & { payloads?: Record<string, unknown> };

async function handle(
  payload: MattermostEventPayload,
  options: MonitorOptions = {},
  verify: () => Promise<void> = async () => {},
) {
  return await withLoopbackMattermost({ ...payloads, ...options.payloads }, async (baseUrl) => {
    const monitor = createLoopbackMonitorContext({
      baseUrl,
      enqueueSystemEvent: state.enqueueSystemEvent,
      config: { groupPolicy: "open", ...options.config },
      current: options.current,
    });
    await createMattermostSystemEventHandler(monitor)(payload);
    await verify();
  });
}

const postEvent = (
  event: "post_edited" | "post_deleted",
  post: Record<string, unknown>,
): MattermostEventPayload => ({
  event,
  data: { post: JSON.stringify({ channel_id: CHANNEL_ID, ...post }) },
  broadcast: { channel_id: CHANNEL_ID },
});
const memberEvent = (event: "user_added" | "user_removed", userId: string) => ({
  event,
  data: { user_id: userId, team_id: "team-1" },
  broadcast: { channel_id: CHANNEL_ID },
});

describe("mattermost system events", () => {
  it.each([
    {
      label: "a user's edit",
      payload: postEvent("post_edited", { id: "post-1", user_id: "user-1", update_at: 42 }),
      text: "Mattermost message edited by @alice in #deploys (post post-1).",
      contextKey: "mattermost:post:edited:post-1:42",
    },
    {
      label: "a user's delete",
      payload: postEvent("post_deleted", { id: "post-1", user_id: "user-1", update_at: 42 }),
      text: "Mattermost message deleted by @alice in #deploys (post post-1).",
      contextKey: "mattermost:post:deleted:post-1:42",
    },
    {
      label: "a threaded edit into the thread session",
      payload: postEvent("post_edited", { id: "post-reply", user_id: "user-1", root_id: "root-1" }),
      sessionKey: `${SESSION_KEY}:thread:root-1`,
    },
    {
      label: "another member's join",
      payload: memberEvent("user_added", "user-2"),
      text: "Mattermost: @bob joined #deploys.",
      contextKey: `mattermost:member:joined:${CHANNEL_ID}:user-2`,
    },
    {
      label: "another member's leave",
      payload: memberEvent("user_removed", "user-2"),
      text: "Mattermost: @bob left #deploys.",
      contextKey: `mattermost:member:left:${CHANNEL_ID}:user-2`,
    },
  ])(
    "forwards $label as a routed system event",
    async ({ payload, text, sessionKey, contextKey }) => {
      await handle(payload);
      expect(state.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
        text ?? expect.any(String),
        expect.objectContaining({
          sessionKey: sessionKey ?? SESSION_KEY,
          ...(contextKey ? { contextKey } : {}),
        }),
      );
      expect(state.reportChannelRoomJoin).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "the bot's own edit", post: { id: "preview", user_id: BOT_USER_ID } },
    { label: "a system post", post: { id: "sys", user_id: "user-1", type: "system_header" } },
  ])("ignores $label", async ({ post }) => {
    await handle(postEvent("post_edited", post));
    expect(state.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("introduces the bot with channel purpose and recent posts when it is added", async () => {
    await handle(
      memberEvent("user_added", BOT_USER_ID),
      { config: { joinIntro: true } },
      async () => {
        const params = state.reportChannelRoomJoin.mock.lastCall?.[0];
        await expect(params?.resolveRoomContext({ messageLimit: 100 })).resolves.toEqual({
          title: "Deploys",
          purpose: "Ship things\nDeploy window: weekdays",
          recentMessages: [
            { sender: "alice", text: "first" },
            { sender: "bob", text: "second" },
          ],
        });
      },
    );
    expect(state.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(state.reportChannelRoomJoin).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "mattermost",
        conversationId: CHANNEL_ID,
        deliverTo: `channel:${CHANNEL_ID}`,
        route: expect.objectContaining({ agentId: "main", sessionKey: SESSION_KEY }),
      }),
    );
  });

  it.each([
    { label: "introductions were never enabled", options: {}, reason: "disabled" },
    {
      label: "the group policy is disabled",
      options: { config: { joinIntro: true, groupPolicy: "disabled" } },
      reason: "room-not-allowed",
    },
    {
      label: "the group policy was disabled after the monitor started",
      options: { config: { joinIntro: true }, current: { groupPolicy: "disabled" } },
      reason: "room-not-allowed",
    },
    {
      label: "the account was disabled after the monitor started",
      options: { config: { joinIntro: true }, current: { enabled: false } },
      reason: "room-not-allowed",
    },
  ] satisfies { label: string; options: MonitorOptions; reason: string }[])(
    "skips the introduction without reading or posting when $label",
    async ({ options, reason }) => {
      await reportThroughOwner();
      const requests = await handle(memberEvent("user_added", BOT_USER_ID), options);
      expect(requests.filter((request) => request.includes("/posts"))).toEqual([]);
      await expect(state.reportChannelRoomJoin.mock.results[0]?.value).resolves.toEqual({
        kind: "skipped",
        reason,
      });
      expect(state.enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

  it("stops the introduction when the group policy is disabled while the room context loads", async () => {
    await reportThroughOwner();
    const current: Partial<MattermostConfig> = {};
    const requests = await handle(memberEvent("user_added", BOT_USER_ID), {
      config: { joinIntro: true },
      current,
      payloads: {
        [POSTS_PATH]: () => {
          current.groupPolicy = "disabled";
          return payloads[POSTS_PATH];
        },
      },
    });
    expect(requests).toContain(`GET ${POSTS_PATH}`);
    // The owner skips before the introduction turn starts: no post reaches the loopback server.
    expect(requests.filter((request) => request.startsWith("POST"))).toEqual([]);
    await expect(state.reportChannelRoomJoin.mock.results[0]?.value).resolves.toEqual({
      kind: "skipped",
      reason: "room-not-allowed",
    });
  });
});
