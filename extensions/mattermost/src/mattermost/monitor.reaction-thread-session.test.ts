import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient } from "./client.js";
import { createMattermostReactionHandler } from "./monitor-reactions.js";
import { createMattermostMonitorResources } from "./monitor-resources.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

const LOOPBACK_TOKEN = "mattermost-loopback-thread-reaction-token";
const CHANNEL_ID = "chan-1";
const BASE_SESSION_KEY = `mattermost:default:channel:${CHANNEL_ID}`;

const loopbackState = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  runtimeCore: undefined as unknown,
}));

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => loopbackState.runtimeCore,
  getOptionalMattermostRuntime: () => loopbackState.runtimeCore,
}));

afterEach(() => loopbackState.enqueueSystemEvent.mockClear());

type LoopbackPost = { id: string; channel_id?: string; user_id?: string; root_id?: string };

async function withLoopbackMattermost(
  post: LoopbackPost | null,
  run: (baseUrl: string, requests: string[]) => Promise<void>,
) {
  const requests: string[] = [];
  const payloads: Record<string, unknown> = {
    [`/api/v4/channels/${CHANNEL_ID}`]: {
      id: CHANNEL_ID,
      name: "town-square",
      display_name: "Town Square",
      type: "O",
    },
    "/api/v4/users/user-1": { id: "user-1", username: "alice", update_at: 1 },
  };
  if (post) {
    payloads[`/api/v4/posts/${post.id}`] = { channel_id: CHANNEL_ID, ...post };
  }
  await withServer(
    (request, response) => {
      const url = request.url ?? "";
      requests.push(`${request.method ?? "GET"} ${url}`);
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== `Bearer ${LOOPBACK_TOKEN}`) {
        response.writeHead(401);
        response.end(JSON.stringify({ message: "unauthorized" }));
        return;
      }
      const payload = Object.hasOwn(payloads, url) ? payloads[url] : undefined;
      response.writeHead(payload ? 200 : 404);
      response.end(JSON.stringify(payload ?? { message: "unknown loopback endpoint" }));
    },
    (baseUrl) => run(baseUrl, requests),
  );
}

async function runReactionThroughMonitor(params: { baseUrl: string; postId: string }) {
  const runtimeCore = createPluginRuntimeMock();
  runtimeCore.channel.routing.resolveAgentRoute = () => ({
    channel: "mattermost",
    matchedBy: "default",
    accountId: "default",
    agentId: "main",
    lastRoutePolicy: "main",
    mainSessionKey: BASE_SESSION_KEY,
    sessionKey: BASE_SESSION_KEY,
  });
  runtimeCore.system.enqueueSystemEvent = loopbackState.enqueueSystemEvent;
  loopbackState.runtimeCore = runtimeCore;

  const connection = { baseUrl: params.baseUrl, botToken: LOOPBACK_TOKEN };
  const client = createMattermostClient({ ...connection, allowPrivateNetwork: true });
  const resources = createMattermostMonitorResources({
    accountId: "default",
    callbackUrl: "http://127.0.0.1:9/mattermost/callback",
    client,
    logger: { debug: () => {} },
    mediaMaxBytes: 1024,
    saveRemoteMedia: async () => ({ path: "/tmp/mattermost-loopback-media" }),
    mediaKindFromMime: () => null,
  });
  const config = { ...connection, enabled: true, dmPolicy: "open", groupPolicy: "open" } as const;
  const cfg = { channels: { mattermost: config } };
  const monitor = {
    account: resolveMattermostAccount({ cfg }),
    botUserId: "bot-user",
    cfg,
    core: runtimeCore,
    groupPolicy: "open",
    pairing: { readAllowFromStore: async () => [] },
    resources,
    logVerboseMessage: () => {},
    logDebugMessage: () => {},
  } as unknown as MattermostMonitorContext;

  const handler = createMattermostReactionHandler(monitor);
  await handler({
    event: "reaction_added",
    data: {
      reaction: JSON.stringify({
        user_id: "user-1",
        post_id: params.postId,
        emoji_name: "thumbsup",
      }),
      channel_id: CHANNEL_ID,
    },
    broadcast: { channel_id: CHANNEL_ID },
  });
}

describe("mattermost reaction thread placement", () => {
  it.each([
    {
      post: { id: "post-reply", root_id: "root-1" },
      sessionKey: `${BASE_SESSION_KEY}:thread:root-1`,
    },
    { post: null, sessionKey: BASE_SESSION_KEY },
  ])("uses session $sessionKey after the production post lookup", async ({ post, sessionKey }) => {
    const postId = post?.id ?? "post-unknown";
    await withLoopbackMattermost(post, async (baseUrl, requests) => {
      await runReactionThroughMonitor({ baseUrl, postId });
      expect(requests).toContain(`GET /api/v4/posts/${postId}`);
      expect(loopbackState.enqueueSystemEvent).toHaveBeenCalledTimes(1);
      expect(loopbackState.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("Mattermost reaction added"),
        expect.objectContaining({
          sessionKey,
          contextKey: `mattermost:reaction:${postId}:thumbsup:user-1:added`,
        }),
      );
    });
  });
});
