import { ChannelType, GuildMemberFlags } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { peekSystemEvents, resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { buildDiscordQuestionCustomId } from "../question-custom-id.js";
import { createAgentComponentButton } from "./agent-components.system-controls.js";
import { clearDiscordChannelInfoCacheForTest } from "./message-channel-info.test-support.js";
import { createDiscordQuestionButton } from "./questions.js";

const GUILD = "100000000000000001";
const CHANNEL = "100000000000000002";
const THREAD = "100000000000000003";
const USER = "100000000000000004";
const OTHER_CHANNEL = "100000000000000005";
const OTHER_THREAD = "100000000000000006";
const CATEGORY = "100000000000000007";
const CATEGORY_CHILD = "100000000000000008";
const GROUP_DM = "100000000000000009";
const OTHER_GROUP_DM = "100000000000000010";
const QUESTION_ID = "ask_0123456789abcdef0123456789abcdef";
const QUESTION_CUSTOM_ID = buildDiscordQuestionCustomId({
  questionId: QUESTION_ID,
  optionIndex: 0,
});

const CHANNELS = {
  [CHANNEL]: { id: CHANNEL, type: ChannelType.GuildText, name: "allowed" },
  [THREAD]: { id: THREAD, type: ChannelType.PublicThread, parent_id: CHANNEL, name: "topic" },
  [OTHER_CHANNEL]: { id: OTHER_CHANNEL, type: ChannelType.GuildText, name: "other" },
  [OTHER_THREAD]: {
    id: OTHER_THREAD,
    type: ChannelType.PublicThread,
    parent_id: OTHER_CHANNEL,
    name: "other-topic",
  },
  [CATEGORY_CHILD]: {
    id: CATEGORY_CHILD,
    type: ChannelType.GuildText,
    parent_id: CATEGORY,
    name: "category-child",
  },
  [GROUP_DM]: { id: GROUP_DM, type: ChannelType.GroupDM, name: "incident-room" },
  [OTHER_GROUP_DM]: { id: OTHER_GROUP_DM, type: ChannelType.GroupDM, name: "side-chat" },
} as const;
type ChannelId = keyof typeof CHANNELS;

// `released` holds every channel lookup until it settles, to model slow Discord REST.
function attachChannelRest(
  client: ReturnType<typeof createInternalTestClient>,
  released?: Promise<void>,
) {
  const post = vi.fn(async (_path: string, _request?: unknown) => undefined);
  const get = vi.fn(async (path: string): Promise<unknown> => {
    await released;
    const channel = CHANNELS[path.replace("/channels/", "") as ChannelId];
    if (!channel) {
      throw new Error(`Unexpected Discord GET ${path}`);
    }
    return channel;
  });
  attachRestMock(client, { get, post });
  return { get, post };
}

// hydrated=false is the payload shape Discord can send: channel_id without a channel object.
function componentPayload(params: { channelId: ChannelId; hydrated: boolean; customId: string }) {
  return createInternalComponentInteractionPayload({
    id: "interaction1",
    token: "test-token",
    guild_id: GUILD,
    channel_id: params.channelId,
    member: {
      user: { id: USER, username: "tester", discriminator: "0", avatar: null, global_name: null },
      roles: [],
      joined_at: "2026-01-01T00:00:00.000Z",
      deaf: false,
      mute: false,
      permissions: "0",
      flags: GuildMemberFlags.CompletedOnboarding,
    },
    ...(params.hydrated ? { channel: CHANNELS[params.channelId] } : {}),
    data: { custom_id: params.customId },
  });
}

function groupDmPayload(params: { channelId: ChannelId; hydrated: boolean }) {
  return createInternalComponentInteractionPayload({
    id: "interaction1",
    token: "test-token",
    channel_id: params.channelId,
    user: { id: USER, username: "tester", discriminator: "0", avatar: null, global_name: null },
    ...(params.hydrated ? { channel: CHANNELS[params.channelId] } : {}),
    data: { custom_id: "agent:componentId=hello" },
  });
}

// DM policy is open to everyone, so only Group DM classification can reject a click.
function createGroupDmHarness(released?: Promise<void>) {
  const client = createInternalTestClient();
  client.componentHandler.register(
    createAgentComponentButton({
      cfg: {},
      accountId: "default",
      dmPolicy: "open",
      allowFrom: ["*"],
      discordConfig: { dm: { groupEnabled: true, groupChannels: ["incident-room"] } },
    }),
  );
  const sessionEvents = (kind: "direct" | "group", id: string) =>
    peekSystemEvents(
      buildAgentSessionKey({
        agentId: "main",
        channel: "discord",
        accountId: "default",
        peer: { kind, id },
      }),
    );
  return { client, sessionEvents, ...attachChannelRest(client, released) };
}

function createQuestionHarness(released?: Promise<void>) {
  const guildEntries = {
    [GUILD]: { channels: { [CHANNEL]: { enabled: true }, [CATEGORY]: { enabled: true } } },
  };
  const discordConfig = { groupPolicy: "allowlist" as const, guilds: guildEntries };
  const cfg: OpenClawConfig = { channels: { discord: discordConfig } };
  const resolveQuestion = vi.fn(async () => ({
    status: "answered" as const,
    questionId: QUESTION_ID,
    optionValue: "Yes",
  }));
  const client = createInternalTestClient();
  client.componentHandler.register(
    createDiscordQuestionButton({
      cfg,
      accountId: "default",
      authContext: { cfg, accountId: "default", discordConfig, guildEntries, allowFrom: [] },
      resolveQuestion,
    }),
  );
  return { client, resolveQuestion, ...attachChannelRest(client, released) };
}

const RETRY_REPLY = "Channel details are unavailable right now. Try this interaction again.";

type ReplyBody = { content?: string; data?: { content?: string } };

// Ephemeral text the user sees, whether sent as the initial callback or a follow-up webhook.
function replyContents(post: ReturnType<typeof attachChannelRest>["post"]) {
  return post.mock.calls.flatMap(([, request]) => {
    const body = (request as { body?: ReplyBody } | undefined)?.body;
    const content = body?.data?.content ?? body?.content;
    return content === undefined ? [] : [content];
  });
}

// Discord fails a component click that gets no response within 3 seconds; component
// callbacks cannot defer before authorization, so a stalled lookup must not hold them.
async function expectSettledWithinLookupBound(handled: Promise<unknown>) {
  let settled = false;
  const observed = handled.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000, interval: 10 });
  await observed;
  await handled;
}

describe("Client.handleInteraction component channel identity", () => {
  beforeEach(() => {
    clearDiscordChannelInfoCacheForTest();
    resetSystemEventsForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  if (!QUESTION_CUSTOM_ID) {
    throw new Error("question custom id fixture is invalid");
  }
  const customId = QUESTION_CUSTOM_ID;

  it.each([true, false])(
    "answers a question from a thread whose parent is allowlisted (hydrated=%s)",
    async (hydrated) => {
      const harness = createQuestionHarness();

      await harness.client.handleInteraction(
        componentPayload({ channelId: THREAD, hydrated, customId }),
      );

      expect(harness.resolveQuestion).toHaveBeenCalledOnce();
      expect(replyContents(harness.post)).toEqual(["Answer submitted."]);
    },
  );

  it("answers a hydrated thread question without waiting for a stalled parent lookup", async () => {
    vi.useFakeTimers();
    const harness = createQuestionHarness(new Promise(() => {}));

    await expectSettledWithinLookupBound(
      harness.client.handleInteraction(
        componentPayload({ channelId: THREAD, hydrated: true, customId }),
      ),
    );

    expect(harness.get.mock.calls.map(([path]) => path)).toEqual([`/channels/${CHANNEL}`]);
    expect(harness.resolveQuestion).toHaveBeenCalledOnce();
    expect(replyContents(harness.post)).toEqual(["Answer submitted."]);
  });

  it("asks for a retry when a raw thread id lookup stalls, then answers once it lands", async () => {
    vi.useFakeTimers();
    const lookup = createDeferred<void>();
    const harness = createQuestionHarness(lookup.promise);

    await expectSettledWithinLookupBound(
      harness.client.handleInteraction(
        componentPayload({ channelId: THREAD, hydrated: false, customId }),
      ),
    );

    expect(harness.resolveQuestion).not.toHaveBeenCalled();
    expect(replyContents(harness.post)).toEqual([RETRY_REPLY]);

    lookup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await harness.client.handleInteraction(
      componentPayload({ channelId: THREAD, hydrated: false, customId }),
    );

    expect(harness.resolveQuestion).toHaveBeenCalledOnce();
    expect(replyContents(harness.post).at(-1)).toBe("Answer submitted.");
  });

  it.each([
    { name: "thread whose parent is not allowlisted", channelId: OTHER_THREAD, hydrated: true },
    { name: "thread whose parent is not allowlisted", channelId: OTHER_THREAD, hydrated: false },
    {
      name: "text channel under an allowlisted category",
      channelId: CATEGORY_CHILD,
      hydrated: true,
    },
    {
      name: "text channel under an allowlisted category",
      channelId: CATEGORY_CHILD,
      hydrated: false,
    },
  ] as const)(
    "rejects a question from a $name (hydrated=$hydrated)",
    async ({ channelId, hydrated }) => {
      const harness = createQuestionHarness();

      await harness.client.handleInteraction(componentPayload({ channelId, hydrated, customId }));

      expect(harness.resolveQuestion).not.toHaveBeenCalled();
      expect(replyContents(harness.post)).toEqual([
        "You are not authorized to answer this question.",
      ]);
    },
  );

  it.each([true, false])(
    "routes an agent button in a thread through its parent channel binding (hydrated=%s)",
    async (hydrated) => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main" }, { id: "worker" }] },
        bindings: [
          { agentId: "main", match: { channel: "discord", accountId: "default" } },
          {
            agentId: "worker",
            match: {
              channel: "discord",
              accountId: "default",
              peer: { kind: "channel", id: CHANNEL },
            },
          },
        ],
        channels: { discord: { groupPolicy: "open" } },
      };
      const client = createInternalTestClient();
      client.componentHandler.register(createAgentComponentButton({ cfg, accountId: "default" }));
      attachChannelRest(client);

      await client.handleInteraction(
        componentPayload({ channelId: THREAD, hydrated, customId: "agent:componentId=hello" }),
      );

      const threadSession = (agentId: string) =>
        buildAgentSessionKey({
          agentId,
          channel: "discord",
          accountId: "default",
          peer: { kind: "channel", id: THREAD },
        });
      expect(peekSystemEvents(threadSession("worker"))).toEqual([
        `[Discord component: hello clicked by tester (${USER})]`,
      ]);
      expect(peekSystemEvents(threadSession("main"))).toEqual([]);
    },
  );

  it.each([true, false])(
    "routes a Group DM click allowlisted by name to the group session (hydrated=%s)",
    async (hydrated) => {
      const harness = createGroupDmHarness();

      await harness.client.handleInteraction(groupDmPayload({ channelId: GROUP_DM, hydrated }));

      expect(harness.sessionEvents("group", GROUP_DM)).toEqual([
        `[Discord component: hello clicked by tester (${USER})]`,
      ]);
      expect(harness.sessionEvents("direct", USER)).toEqual([]);
    },
  );

  it.each([true, false])(
    "rejects a Group DM click outside dm.groupChannels even when DMs are open (hydrated=%s)",
    async (hydrated) => {
      const harness = createGroupDmHarness();

      await harness.client.handleInteraction(
        groupDmPayload({ channelId: OTHER_GROUP_DM, hydrated }),
      );

      expect(replyContents(harness.post)).toEqual(["You are not authorized to use this button."]);
      expect(harness.sessionEvents("group", OTHER_GROUP_DM)).toEqual([]);
      expect(harness.sessionEvents("direct", USER)).toEqual([]);
    },
  );

  it("asks for a retry instead of applying DM policy when a raw Group DM lookup stalls", async () => {
    vi.useFakeTimers();
    const harness = createGroupDmHarness(new Promise(() => {}));

    await expectSettledWithinLookupBound(
      harness.client.handleInteraction(
        groupDmPayload({ channelId: OTHER_GROUP_DM, hydrated: false }),
      ),
    );

    expect(replyContents(harness.post)).toEqual([RETRY_REPLY]);
    expect(harness.sessionEvents("group", OTHER_GROUP_DM)).toEqual([]);
    expect(harness.sessionEvents("direct", USER)).toEqual([]);
  });

  it.each([
    {
      name: "fails",
      lookup: async () => {
        throw new Error("Missing Access");
      },
    },
    { name: "returns no channel", lookup: async () => undefined },
  ])(
    "asks for a retry instead of applying DM policy when a raw Group DM lookup $name",
    async ({ lookup }) => {
      const harness = createGroupDmHarness();
      harness.get.mockImplementation(lookup);

      await harness.client.handleInteraction(
        groupDmPayload({ channelId: OTHER_GROUP_DM, hydrated: false }),
      );

      expect(replyContents(harness.post)).toEqual([RETRY_REPLY]);
      expect(harness.sessionEvents("group", OTHER_GROUP_DM)).toEqual([]);
      expect(harness.sessionEvents("direct", USER)).toEqual([]);
    },
  );
});
