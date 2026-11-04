import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import * as initialStateRuntime from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMattermostConversationDeliveryTarget } from "../conversation-bindings.js";
import type { MattermostClient } from "./client.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

const CHANNEL_ID = "chan-1";
const ASKER_POST_ID = "post-1";
const CHILD_SESSION_KEY = "agent:main:subagent:child-1";
const BASE_SESSION_KEY = `agent:main:mattermost:channel:${CHANNEL_ID}`;
const cfg = { channels: { mattermost: { botToken: "token", baseUrl: "https://mm.example" } } };

let stateRuntime = initialStateRuntime;
let bindings: typeof import("./thread-bindings.js");
let bindingService: typeof import("openclaw/plugin-sdk/conversation-binding-runtime");
let eventPlan: typeof import("./monitor-event-plan.js");
let managers: Array<{ stop: () => void }> = [];

const askerPost = {
  [`/posts/${ASKER_POST_ID}`]: { id: ASKER_POST_ID, channel_id: CHANNEL_ID, root_id: "" },
};

function createClient(lookups: Record<string, unknown> = {}) {
  const created: Array<{ channel_id: string; message: string; root_id?: string }> = [];
  const request = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST" && path === "/posts") {
      const post = JSON.parse(init.body ?? "{}");
      created.push(post);
      return { ...post, id: post.root_id ? `reply-${created.length}` : "root-2" };
    }
    const post = lookups[path];
    if (!post) {
      throw new Error(`404 ${path}`);
    }
    return post;
  });
  return Object.assign({ request } as unknown as MattermostClient, { created, request });
}

async function createManager(client = createClient(), config: object = cfg) {
  const manager = await bindings.createMattermostThreadBindingManager({
    cfg: config,
    accountId: "default",
    botUserId: "bot-1",
    client,
    enableSweeper: false,
  });
  managers.push(manager);
  return manager;
}

function bindChild(params: {
  conversationId: string;
  parentConversationId?: string;
  sourceMessageId?: string;
}) {
  return bindingService.getSessionBindingService().bind({
    targetSessionKey: CHILD_SESSION_KEY,
    targetKind: "subagent",
    placement: "child",
    conversation: {
      channel: "mattermost",
      accountId: "default",
      conversationId: params.conversationId,
      ...(params.parentConversationId ? { parentConversationId: params.parentConversationId } : {}),
    },
    ...(params.sourceMessageId ? { sourceMessageId: params.sourceMessageId } : {}),
    metadata: { agentId: "main", label: "research", threadName: "🤖 research", introText: "intro" },
  });
}

function planFor(threadRootId: string) {
  const monitor = {
    cfg,
    account: { accountId: "default", config: {} },
    core: {
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            channel: "mattermost",
            accountId: "default",
            agentId: "main",
            matchedBy: "default",
            lastRoutePolicy: "main",
            mainSessionKey: BASE_SESSION_KEY,
            sessionKey: BASE_SESSION_KEY,
          }),
        },
      },
    },
    resources: { resolveChannelInfo: async () => ({ id: CHANNEL_ID, type: "O", name: "town" }) },
    logVerboseMessage: () => {},
  } as unknown as MattermostMonitorContext;
  return eventPlan.buildMattermostEventPlan(monitor, {
    channelId: CHANNEL_ID,
    senderId: "user-1",
    postId: "reply-1",
    threadRootId,
    dropLabel: "post",
  });
}

describe("mattermost thread-bound sub-agent sessions", () => {
  beforeEach(async () => {
    stateRuntime.resetPluginStateStoreForTests();
    vi.resetModules();
    // Store factories and their worker admissions must share one module generation.
    stateRuntime = await import("openclaw/plugin-sdk/plugin-state-test-runtime");
    const { setMattermostRuntime } = await import("../runtime.js");
    setMattermostRuntime({
      state: {
        openKeyedStoreV2: (options: OpenKeyedStoreOptions) =>
          stateRuntime.createPluginStateKeyedStoreV2ForTests("mattermost", options, {
            assertCurrent() {},
          }),
      },
    } as unknown as PluginRuntime);
    bindings = await import("./thread-bindings.js");
    bindingService = await import("openclaw/plugin-sdk/conversation-binding-runtime");
    eventPlan = await import("./monitor-event-plan.js");
  });

  afterEach(async () => {
    // Plugin state outlives a test in this file; drop this test's bindings first.
    await bindings.handleMattermostSubagentEnded({ targetSessionKey: CHILD_SESSION_KEY });
    for (const manager of managers) {
      manager.stop();
    }
    managers = [];
    stateRuntime.resetPluginStateStoreForTests();
  });

  it("opens the child thread under the asker's top-level post", async () => {
    const client = createClient(askerPost);
    await createManager(client);

    const binding = await bindChild({ conversationId: CHANNEL_ID, sourceMessageId: ASKER_POST_ID });

    expect(binding.conversation).toMatchObject({
      channel: "mattermost",
      conversationId: ASKER_POST_ID,
      parentConversationId: CHANNEL_ID,
    });
    // Only the intro is posted, inside the asker's thread; no new root post.
    expect(client.created).toEqual([
      { channel_id: CHANNEL_ID, message: "intro", root_id: ASKER_POST_ID },
    ]);
    // Completion delivery for the bound conversation lands in that thread.
    expect(resolveMattermostConversationDeliveryTarget(binding.conversation)).toEqual({
      to: `channel:${CHANNEL_ID}`,
      threadId: ASKER_POST_ID,
    });
  });

  it("opens a new root post when the asker's thread is the requester's own conversation", async () => {
    const client = createClient();
    await createManager(client);

    // replyToMode first/all, or a post inside a thread: the requester already owns root post-1.
    const binding = await bindChild({
      conversationId: ASKER_POST_ID,
      parentConversationId: CHANNEL_ID,
      sourceMessageId: ASKER_POST_ID,
    });

    expect(binding.conversation).toMatchObject({
      conversationId: "root-2",
      parentConversationId: CHANNEL_ID,
    });
    expect(client.created).toEqual([
      { channel_id: CHANNEL_ID, message: "🤖 research" },
      { channel_id: CHANNEL_ID, message: "intro", root_id: "root-2" },
    ]);
  });

  it("rejects thread spawns from flat direct messages", async () => {
    const client = createClient();
    await createManager(client);

    await expect(
      bindChild({ conversationId: "user:user-1", sourceMessageId: ASKER_POST_ID }),
    ).rejects.toThrow(/direct messages are flat/);
    expect(client.created).toEqual([]);
  });

  it("routes follow-ups in the bound thread to the child session", async () => {
    const client = createClient(askerPost);
    await createManager(client);
    await bindChild({ conversationId: CHANNEL_ID, sourceMessageId: ASKER_POST_ID });

    const bound = await planFor(ASKER_POST_ID);
    const other = await planFor("other-root");

    expect(bound).toMatchObject({
      boundThread: true,
      route: { sessionKey: CHILD_SESSION_KEY },
      thread: { sessionKey: CHILD_SESSION_KEY, effectiveReplyToId: ASKER_POST_ID },
    });
    expect(other).toMatchObject({
      boundThread: false,
      thread: { sessionKey: `${BASE_SESSION_KEY}:thread:other-root` },
    });
  });

  it("keeps bindings across restarts and unbinds when the sub-agent ends", async () => {
    const client = createClient(askerPost);
    await createManager(client);
    await bindChild({ conversationId: CHANNEL_ID, sourceMessageId: ASKER_POST_ID });
    // A monitor restart replaces the manager, which reloads bindings from plugin state.
    const restarted = await createManager(client);
    expect(restarted.getByConversationId(ASKER_POST_ID)?.targetSessionKey).toBe(CHILD_SESSION_KEY);

    await bindings.handleMattermostSubagentEnded({
      targetSessionKey: CHILD_SESSION_KEY,
      targetKind: "subagent",
      reason: "completed",
      sendFarewell: true,
    });

    expect(restarted.getByConversationId(ASKER_POST_ID)).toBeUndefined();
    expect(client.created.at(-1)).toMatchObject({ channel_id: CHANNEL_ID, root_id: ASKER_POST_ID });
    restarted.stop();
    expect((await createManager(client)).getByConversationId(ASKER_POST_ID)).toBeUndefined();
  });
});
