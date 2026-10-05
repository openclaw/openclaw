import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  Routes,
  type APIMessageTopLevelComponent,
} from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Container, TextDisplay } from "./internal/discord.js";
import {
  createDiscordLoopbackRest,
  discordWebMediaMockFactory,
  makeDiscordRest,
  requestBody as requireRestBody,
  requestPath,
} from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", () => discordWebMediaMockFactory());

import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { rememberDiscordDirectoryUser } from "./directory-cache.js";
import { clearDiscordDirectoryCacheForTest } from "./directory-cache.test-support.js";
import {
  deleteMessageDiscord,
  editMessageDiscord,
  pinMessageDiscord,
  unpinMessageDiscord,
} from "./send.messages.js";
import { sendMessageDiscord } from "./send.outbound.js";
import { canViewDiscordGuildChannel, fetchChannelPermissionsDiscord } from "./send.permissions.js";
import {
  fetchReactionsDiscord,
  reactMessageDiscord,
  removeOwnReactionsDiscord,
  removeReactionDiscord,
} from "./send.reactions.js";

const DISCORD_TEST_CFG = {
  channels: { discord: { token: "t" } },
};

function discordClientOpts(rest: ReturnType<typeof makeDiscordRest>["rest"]) {
  return { rest, token: "t", cfg: DISCORD_TEST_CFG };
}

const DISCORD_MARKDOWN_GOLDENS = [
  {
    name: "normalizes nested CommonMark emphasis and strong spans",
    before:
      "__*nested italic*__ __foo*bar*baz__ __a*x*.__ __foo**bar**baz__ __outer __inner__ tail__",
    after:
      "**_nested italic_** **foo*bar*baz** **a*x*.** **foo****bar****baz** **outer **inner** tail**",
  },
  {
    name: "normalizes CommonMark bold containing links without changing destinations",
    before:
      "__See https://example.com and [__docs__](https://example.com)__ __See https://example.com__. __*see https://example.com*__ __<mailto:user*tag@example.com>__",
    after:
      "**See https://example.com and [**docs**](https://example.com)** **See https://example.com**. **_see https://example.com_** **<mailto:user*tag@example.com>**",
  },
  {
    name: "normalizes CommonMark bold around URLs with parentheses and asterisks",
    before:
      "__https://example.com/a(b)*c__ __<https://example.com/a(b)*c>__ ____https://example.com____ https://[2001:db8::1]/__v1__ ftp://example.com/__v2__ WWW.example.com/__v3__",
    after:
      "__https://example.com/a(b)*c__ **<https://example.com/a(b)*c>** ****https://example.com**** https://[2001:db8::1]/__v1__ ftp://example.com/__v2__ WWW.example.com/__v3__",
  },
  {
    name: "keeps escaped and intraword underscores literal",
    before: "\\__literal__ foo__bar__baz awww.__bold__ \\\\__bold__",
    after: "\\__literal__ foo__bar__baz awww.**bold** \\\\**bold**",
  },
  {
    name: "keeps underscore markers inside code byte-identical",
    before:
      "`__inline__` ``tick ` __literal__`` `a` __bold__ `b` `__` __outside__\n\n````md\nline\n```\n__fenced__\n````",
    after:
      "`__inline__` ``tick ` __literal__`` `a` **bold** `b` `__` **outside**\n\n````md\nline\n```\n__fenced__\n````",
  },
  {
    name: "keeps indentation and special link destinations byte-identical",
    before:
      '    a\n    b\n\n[x](<https://example.test/__v1__/a)>)\n<https://example.test/__v1__/>\nhttps://example.test/__v1__/bare\n<:__wave__:123456789012345678> <a:__dance__:123456789012345679> </__foo__:123456789012345680>\n\n[r]: https://example.test/__v1__/unused\n  "__title__"',
    after:
      '    a\n    b\n\n[x](<https://example.test/__v1__/a)>)\n<https://example.test/__v1__/>\nhttps://example.test/__v1__/bare\n<:__wave__:123456789012345678> <a:__dance__:123456789012345679> </__foo__:123456789012345680>\n\n[r]: https://example.test/__v1__/unused\n  "__title__"',
  },
  {
    name: "escapes literal asterisks when normalizing underscore bold",
    before: "__safe__ and __a * b__ and __foo **bar__",
    after: "**safe** and **a \\* b** and **foo \\*\\*bar**",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  clearDiscordDirectoryCacheForTest();
});

function expectRestRoute(
  mock: Parameters<typeof requestPath>[0],
  callIndex: number,
  expected: string,
) {
  expect(requestPath(mock, callIndex)).toBe(expected);
}

function expectSingleReceiptPart(receipt: unknown, expected: Record<string, unknown>) {
  expect(receipt).toMatchObject({ parts: [expect.objectContaining(expected)] });
}

function expectBodyFileName(body: unknown, expectedName: string) {
  expect(body).toMatchObject({ files: [expect.objectContaining({ name: expectedName })] });
}

const overwrite = (id: string, deny = 0n, allow = 0n) => ({
  id,
  deny: deny.toString(),
  allow: allow.toString(),
});
function permissionFixture({
  type = ChannelType.GuildText,
  permissions = 0n,
  overwrites = [],
  roles = [],
  bot = false,
  sending = false,
}: {
  type?: ChannelType;
  permissions?: bigint;
  overwrites?: ReturnType<typeof overwrite>[];
  roles?: string[];
  bot?: boolean;
  sending?: boolean;
}) {
  const mocks = makeDiscordRest();
  const thread = type === ChannelType.PublicThread || type === ChannelType.PrivateThread;
  const channel = {
    id: "chan1",
    guild_id: "guild1",
    type,
    parent_id: thread ? "parent1" : undefined,
    permission_overwrites: overwrites,
  };
  if (sending) {
    mocks.getMock.mockResolvedValueOnce(channel);
  }
  mocks.getMock.mockResolvedValueOnce(channel);
  if (thread) {
    mocks.getMock.mockResolvedValueOnce({ ...channel, id: "parent1", type: ChannelType.GuildText });
  }
  if (bot) {
    mocks.getMock.mockResolvedValueOnce({ id: "user1" });
  }
  mocks.getMock
    .mockResolvedValueOnce({
      id: "guild1",
      roles: [
        { id: "guild1", permissions: permissions.toString() },
        ...roles.map((id) => ({ id, permissions: "0" })),
      ],
    })
    .mockResolvedValueOnce({ roles });
  return mocks;
}

describe("sendMessageDiscord", () => {
  it("keeps missing platform identity ambiguous in progress and final results", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ channel_id: "789" });
    const onDeliveryResult = vi.fn();

    const result = await sendMessageDiscord("channel:789", "hello", {
      ...discordClientOpts(rest),
      onDeliveryResult,
    });

    expect(postMock).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    for (const delivery of [result, onDeliveryResult.mock.calls[0]?.[0]]) {
      expect(delivery).toMatchObject({
        messageId: "",
        channelId: "789",
        receipt: { platformMessageIds: [], parts: [] },
      });
    }
  });

  function expectReplyReference(
    body: { message_reference?: unknown } | undefined,
    messageId: string,
  ) {
    expect(body?.message_reference).toEqual({
      message_id: messageId,
      fail_if_not_exists: false,
    });
  }

  function expectNoReplyReference(body: { message_reference?: unknown } | undefined) {
    expect(body?.message_reference).toBeUndefined();
  }

  it("sends embed-only messages with a card receipt and enforced nonce", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "embed1", channel_id: "789" });
    const onDeliveryResult = vi.fn();

    const result = await sendMessageDiscord("channel:789", "", {
      ...discordClientOpts(rest),
      embeds: [{ title: "Release notes", description: "Version available" }],
      reply: { messageId: "orig-123", scope: "first" },
      allowedMentions: { parse: [] },
      onDeliveryResult,
    });

    expectSingleReceiptPart(result.receipt, { platformMessageId: "embed1", kind: "card" });
    expectSingleReceiptPart(onDeliveryResult.mock.calls[0]?.[0]?.receipt, {
      platformMessageId: "embed1",
      kind: "card",
    });
    expect(requireRestBody(postMock)).toMatchObject({
      embeds: [{ title: "Release notes", description: "Version available" }],
      allowed_mentions: { parse: [] },
      message_reference: { message_id: "orig-123", fail_if_not_exists: false },
      enforce_nonce: true,
    });
    expect(requireRestBody(postMock)).not.toHaveProperty("content");
    expect(requireRestBody(postMock)).not.toHaveProperty("flags");
  });

  it("sends raw Components V2 without legacy content or embeds", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "component2", channel_id: "789" });
    const components: APIMessageTopLevelComponent[] = [
      { type: 17, components: [{ type: 10, content: "Choose an action" }] },
    ];

    const result = await sendMessageDiscord("channel:789", "legacy fallback", {
      ...discordClientOpts(rest),
      components,
      embeds: [{ title: "legacy embed" }],
    });

    expectSingleReceiptPart(result.receipt, { platformMessageId: "component2", kind: "card" });
    expect(requireRestBody(postMock)).toMatchObject({
      components,
      flags: MessageFlags.IsComponentsV2,
      enforce_nonce: true,
    });
    expect(requireRestBody(postMock)).not.toHaveProperty("content");
    expect(requireRestBody(postMock)).not.toHaveProperty("embeds");
  });

  it("keeps native components and embeds on the first message chunk only", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock
      .mockResolvedValueOnce({ id: "component1", channel_id: "789" })
      .mockResolvedValueOnce({ id: "component2", channel_id: "789" });
    const components: APIMessageTopLevelComponent[] = [
      {
        type: 1,
        components: [{ type: 2, style: 1, custom_id: "open", label: "Open" }],
      },
    ];
    const onDeliveryResult = vi.fn();

    const result = await sendMessageDiscord("channel:789", "a".repeat(2_500), {
      ...discordClientOpts(rest),
      components,
      embeds: [{ title: "Release notes" }],
      reply: { messageId: "orig-123", scope: "first" },
      onDeliveryResult,
      silent: true,
    });

    expect(postMock).toHaveBeenCalledTimes(2);
    expect(requireRestBody(postMock, 0)).toMatchObject({
      components,
      embeds: [{ title: "Release notes" }],
      message_reference: { message_id: "orig-123", fail_if_not_exists: false },
    });
    expect(requireRestBody(postMock, 0).flags).toBe(MessageFlags.SuppressNotifications);
    expect(requireRestBody(postMock, 1).flags).toBe(
      MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications,
    );
    expect(requireRestBody(postMock, 1)).not.toHaveProperty("components");
    expect(requireRestBody(postMock, 1)).not.toHaveProperty("embeds");
    expect(requireRestBody(postMock, 1)).not.toHaveProperty("message_reference");
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.receipt.parts[0]?.kind)).toEqual([
      "card",
      "text",
    ]);
    expect(result.receipt.parts.map(({ kind }) => kind)).toEqual(["card", "text"]);
    expect(result.receipt.replyToId).toBe("orig-123");
    expect(result.receipt.parts.map(({ replyToId }) => replyToId)).toEqual(["orig-123", undefined]);
  });

  it.each([{ name: "empty component factory", components: () => [] }])(
    "still rejects empty messages with $name",
    async ({ components }) => {
      const { rest, postMock, getMock } = makeDiscordRest();
      getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });

      await expect(
        sendMessageDiscord("channel:789", "", {
          ...discordClientOpts(rest),
          components,
        }),
      ).rejects.toThrow("Message must be non-empty for Discord sends");
      expect(postMock).not.toHaveBeenCalled();
    },
  );

  it.each(DISCORD_MARKDOWN_GOLDENS)("$name", async ({ before, after }) => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });

    await sendMessageDiscord("channel:789", before, discordClientOpts(rest));

    expect(requireRestBody(postMock).content).toBe(after);
  });

  it("sends a pre-sized fenced media tail once", async () => {
    let messageCount = 0;
    const loopback = await createDiscordLoopbackRest({
      respond: (request) =>
        request.method === "GET"
          ? { id: "789", type: ChannelType.GuildText }
          : { id: `message-${++messageCount}`, channel_id: "789" },
    });
    try {
      const body = "abc ".repeat(14);
      const onDeliveryResult = vi.fn();
      const result = await sendMessageDiscord("channel:789", `\`\`\`txt\n${body}\n\`\`\``, {
        ...discordClientOpts(loopback.rest),
        mediaUrl: "file:///tmp/photo.jpg",
        maxLinesPerMessage: 2,
        onDeliveryResult,
      });
      const requests = loopback.requests.filter((request) => request.method === "POST");
      expect(requests).toHaveLength(2);
      expect(requests[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(JSON.parse(requests[1]?.body ?? "{}").content).toBe(`\`\`\`txt\n${body}\n\`\`\``);
      expect(result.messageId).toBe("message-1");
      expect(result.receipt.platformMessageIds).toEqual(["message-1", "message-2"]);
      expect(onDeliveryResult.mock.calls.map(([part]) => part.messageId)).toEqual([
        "message-1",
        "message-2",
      ]);
    } finally {
      await loopback.close();
    }
  });

  it.each(["delivery callback", "later text send"])(
    "does not retry accepted media when its %s raises an upload error",
    async (failure) => {
      const { rest, postMock } = makeDiscordRest();
      const error = Object.assign(new Error("upload-shaped follow-up failure"), {
        status: 413,
        code: 40005,
      });
      postMock.mockResolvedValueOnce({ id: "media-1", channel_id: "789" });
      const onDeliveryResult = vi.fn();
      if (failure === "delivery callback") {
        onDeliveryResult.mockRejectedValue(error);
      } else {
        postMock.mockRejectedValueOnce(error);
      }
      await expect(
        sendMessageDiscord("channel:789", "a".repeat(2500), {
          ...discordClientOpts(rest),
          mediaUrl: "file:///tmp/photo.jpg",
          onDeliveryResult,
        }),
      ).rejects.toBe(error);
      expect(postMock).toHaveBeenCalledTimes(failure === "delivery callback" ? 1 : 2);
      expect(onDeliveryResult.mock.calls.map(([part]) => part.messageId)).toEqual(["media-1"]);
    },
  );

  it("rechecks delivery authority before media caption follow-up chunks", async () => {
    const loopback = await createDiscordLoopbackRest();
    try {
      const authorityRevoked = new Error("delivery authority revoked");
      let authorityActive = true;
      const onPlatformSendDispatch = vi.fn(async () => {
        if (!authorityActive) {
          throw authorityRevoked;
        }
      });
      const onDeliveryResult = vi.fn(async () => {
        authorityActive = false;
      });

      await expect(
        sendMessageDiscord("channel:789", "a".repeat(2_500), {
          ...discordClientOpts(loopback.rest),
          mediaUrl: "file:///tmp/photo.jpg",
          onDeliveryResult,
          onPlatformSendDispatch,
        }),
      ).rejects.toBe(authorityRevoked);

      expect(onDeliveryResult).toHaveBeenCalledOnce();
      expect(onPlatformSendDispatch).toHaveBeenCalledTimes(2);
      const messageRequests = loopback.requests.filter((request) => request.method === "POST");
      expect(messageRequests).toHaveLength(1);
      expect(messageRequests[0]?.path).toContain("/channels/789/messages");
      expect(messageRequests[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    } finally {
      await loopback.close();
    }
  });

  it("rechecks delivery authority before each retried text post", async () => {
    let authorityActive = true;
    const loopback = await createDiscordLoopbackRest({
      status: (request) => {
        if (request.method === "POST") {
          authorityActive = false;
          return 503;
        }
        return 200;
      },
    });
    try {
      const authorityRevoked = new Error("delivery authority revoked");
      const onPlatformSendDispatch = vi.fn(async () => {
        if (!authorityActive) {
          throw authorityRevoked;
        }
      });

      await expect(
        sendMessageDiscord("channel:789", "retry once", {
          ...discordClientOpts(loopback.rest),
          retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
          onPlatformSendDispatch,
        }),
      ).rejects.toBe(authorityRevoked);

      expect(onPlatformSendDispatch).toHaveBeenCalledTimes(2);
      const messageRequests = loopback.requests.filter((request) => request.method === "POST");
      expect(messageRequests).toHaveLength(1);
    } finally {
      await loopback.close();
    }
  });

  it("fences provider-owned delivery after async dispatch refresh and before REST I/O", async () => {
    const loopback = await createDiscordLoopbackRest();
    try {
      const authorityRevoked = new Error("delivery authority revoked after dispatch refresh");
      let authorityActive = true;
      const onPlatformSendDispatch = async () => {
        await Promise.resolve();
        authorityActive = false;
      };
      const assertPlatformSendAuthorized = () => {
        if (!authorityActive) {
          throw authorityRevoked;
        }
      };

      await expect(
        sendMessageDiscord("channel:789", "must not send", {
          ...discordClientOpts(loopback.rest),
          onPlatformSendDispatch,
          assertPlatformSendAuthorized,
        }),
      ).rejects.toBe(authorityRevoked);

      const messageRequests = loopback.requests.filter((request) => request.method === "POST");
      expect(messageRequests).toHaveLength(0);
    } finally {
      await loopback.close();
    }
  });

  it("allows Discord link embeds when suppressEmbeds is disabled", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });

    await sendMessageDiscord("channel:789", "https://example.com", {
      rest,
      token: "t",
      cfg: {
        channels: {
          discord: {
            token: "t",
            suppressEmbeds: false,
          },
        },
      } as never,
    });

    const body = requireRestBody(postMock);
    expect(body).toMatchObject({
      content: "https://example.com",
      enforce_nonce: true,
    });
    expect(body.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(body.flags).toBeUndefined();
  });

  it.each([
    { input: "Run `notify @Alice", expected: "Run `notify @Alice" },
    { input: "literal \\\\` inside @Alice", expected: "literal \\\\` inside @Alice" },
  ])(
    "rewrites cached @username mentions only outside code: $input",
    async ({ input, expected }) => {
      rememberDiscordDirectoryUser({
        accountId: "default",
        userId: "123456789012345678",
        handles: ["Alice"],
      });
      const { rest, postMock, getMock } = makeDiscordRest();
      getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
      postMock.mockResolvedValue({
        id: "msg1",
        channel_id: "789",
      });
      await sendMessageDiscord("channel:789", input, {
        ...discordClientOpts(rest),
        accountId: "default",
      });
      expectRestRoute(postMock, 0, Routes.channelMessages("789"));
      expect(requireRestBody(postMock).content).toBe(expected);
    },
  );

  it("rewrites configured @username aliases to id-based mentions", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({
      id: "msg1",
      channel_id: "789",
    });
    await sendMessageDiscord("channel:789", "ping @OpsLead", {
      rest,
      token: "t",
      cfg: {
        channels: {
          discord: {
            token: "t",
            mentionAliases: {
              opslead: "123456789012345678",
            },
          },
        },
      } as never,
      accountId: "default",
    });
    expectRestRoute(postMock, 0, Routes.channelMessages("789"));
    expect(requireRestBody(postMock).content).toBe("ping <@123456789012345678>");
  });

  it("uses configured defaultAccount for cached mention rewriting when accountId is omitted", async () => {
    rememberDiscordDirectoryUser({
      accountId: "work",
      userId: "222333444555666777",
      handles: ["Alice"],
    });
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({
      id: "msg1",
      channel_id: "789",
    });
    await sendMessageDiscord("channel:789", "ping @Alice", {
      rest,
      token: "t",
      cfg: {
        channels: {
          discord: {
            defaultAccount: "work",
            suppressEmbeds: false,
            accounts: {
              work: {
                token: "Bot work-token", // pragma: allowlist secret
                suppressEmbeds: true,
              },
            },
          },
        },
      } as never,
    });
    expectRestRoute(postMock, 0, Routes.channelMessages("789"));
    expect(requireRestBody(postMock).content).toBe("ping <@222333444555666777>");
    expect(requireRestBody(postMock).flags).toBe(MessageFlags.SuppressEmbeds);
  });

  it("auto-creates a forum thread when target is a Forum channel", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    // Channel type lookup returns a Forum channel.
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildForum,
      default_auto_archive_duration: 1440,
    });
    postMock.mockResolvedValue({
      id: "thread1",
      message: { id: "starter1", channel_id: "thread1" },
    });
    const res = await sendMessageDiscord(
      "channel:forum1",
      "Discussion topic\nBody of the post",
      discordClientOpts(rest),
    );
    expect(res.messageId).toBe("starter1");
    expect(res.channelId).toBe("thread1");
    expect(res.receipt).toMatchObject({
      threadId: "thread1",
      platformMessageIds: ["starter1"],
    });
    expectSingleReceiptPart(res.receipt, { platformMessageId: "starter1", kind: "text" });
    // Should POST to threads route, not channelMessages.
    expectRestRoute(postMock, 0, Routes.threads("forum1"));
    expect(requireRestBody(postMock)).toEqual({
      name: "Discussion topic",
      auto_archive_duration: 1440,
      message: {
        content: "Discussion topic\nBody of the post",
        flags: MessageFlags.SuppressEmbeds,
      },
    });
  });

  it("explains how to create a forum thread when the parent requires an applied tag", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildForum,
      flags: 1 << 4,
      available_tags: [{ id: "tag1", name: "Question", moderated: false }],
    });

    await expect(
      sendMessageDiscord("channel:forum1", "Discussion topic", discordClientOpts(rest)),
    ).rejects.toThrow(/thread-create with appliedTags/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("starts DM when recipient is a user", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock
      .mockResolvedValueOnce({ id: "chan1" })
      .mockResolvedValueOnce({ id: "msg1", channel_id: "chan1" });
    const res = await sendMessageDiscord("user:123", "hiya", discordClientOpts(rest));
    expectRestRoute(postMock, 0, Routes.userChannels());
    expect(requireRestBody(postMock, 0).recipient_id).toBe("123");
    expectRestRoute(postMock, 1, Routes.channelMessages("chan1"));
    expect(requireRestBody(postMock, 1).content).toBe("hiya");
    expect(res.channelId).toBe("chan1");
  });

  it.each([
    {
      name: "missing channel permission",
      type: ChannelType.GuildText,
      permissions: PermissionFlagsBits.ViewChannel,
      missing: ["SendMessages"],
    },
    {
      name: "baseline permissions already granted",
      type: ChannelType.GuildText,
      permissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
      missing: [],
    },
    {
      name: "thread permission uses SendMessagesInThreads",
      type: ChannelType.PublicThread,
      permissions: PermissionFlagsBits.ViewChannel,
      missing: ["SendMessagesInThreads"],
    },
  ])("reports 50013 diagnostics: $name", async ({ type, permissions, missing }) => {
    const { rest, postMock } = permissionFixture({ type, permissions, bot: true, sending: true });
    postMock.mockRejectedValueOnce(
      Object.assign(new Error("Missing Permissions"), { code: 50013, status: 403 }),
    );
    await expect(
      sendMessageDiscord("channel:chan1", "hello", discordClientOpts(rest)),
    ).rejects.toMatchObject({
      missingPermissions: missing,
      discordCode: 50013,
      status: 403,
      message: expect.stringContaining(
        missing[0] ?? "permission probe did not identify missing ViewChannel/SendMessages",
      ),
    });
  });

  it("sends the detected JPEG media type across a real loopback multipart request", async () => {
    const loopback = await createDiscordLoopbackRest();
    try {
      await sendMessageDiscord("channel:789", "", {
        ...discordClientOpts(loopback.rest),
        mediaUrl: "file:///tmp/photo.jpg",
      });

      const upload = loopback.requests.find((request) => request.method === "POST");
      expect(upload?.path).toContain("/channels/789/messages");
      expect(upload?.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(upload?.body).toContain('name="files[0]"; filename="photo.jpg"');
      expect(upload?.body).toContain("Content-Type: image/jpeg");
      expect(upload?.body).not.toContain('"content":');
      expect(loadWebMedia).toHaveBeenCalledWith("file:///tmp/photo.jpg", {
        maxBytes: 100 * 1024 * 1024,
      });
    } finally {
      await loopback.close();
    }
  });

  it("preserves implicit reply scope and delivery progress in upload fallback chunks", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Bad Request"), {
          status: 400,
          rawError: { code: 40005 },
        }),
      )
      .mockResolvedValueOnce({ id: "fallback-1", channel_id: "789" })
      .mockResolvedValueOnce({ id: "fallback-2", channel_id: "789" });
    const onDeliveryResult = vi.fn();

    await sendMessageDiscord("channel:789", "a".repeat(2500), {
      ...discordClientOpts(rest),
      mediaUrl: "file:///tmp/report.pdf",
      reply: { messageId: "orig-123", scope: "first" },
      onDeliveryResult,
      components: [new Container([new TextDisplay("Attachment controls")])],
      embeds: [{ title: "Attachment preview" }],
    });

    expect(postMock).toHaveBeenCalledTimes(3);
    expectBodyFileName(requireRestBody(postMock, 0), "photo.jpg");
    const fallbackBody = requireRestBody(postMock, 1);
    expect(fallbackBody).not.toHaveProperty("files");
    expect(fallbackBody).not.toHaveProperty("components");
    expect(fallbackBody).not.toHaveProperty("embeds");
    expect(String(requireRestBody(postMock, 2).content)).toContain(
      "[Attachment skipped: Discord rejected the file as too large.]",
    );
    expectReplyReference(requireRestBody(postMock, 1), "orig-123");
    expectNoReplyReference(requireRestBody(postMock, 2));
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.messageId)).toEqual([
      "fallback-1",
      "fallback-2",
    ]);
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.receipt.parts[0]?.replyToId)).toEqual(
      ["orig-123", undefined],
    );
  });

  it("reports a media-only upload rejected with HTTP 413", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock
      .mockRejectedValueOnce(Object.assign(new Error("Bad Request"), { status: 413 }))
      .mockResolvedValueOnce({ id: "fallback-msg", channel_id: "789" });

    const res = await sendMessageDiscord("channel:789", "", {
      ...discordClientOpts(rest),
      mediaUrl: "file:///tmp/photo.jpg",
    });

    expect(res.messageId).toBe("fallback-msg");
    expect(requireRestBody(postMock, 1).content).toBe(
      "Attachment skipped: Discord rejected the file as too large.",
    );
    expect(requireRestBody(postMock, 1)).not.toHaveProperty("files");
  });

  it("does not mask unrelated media upload failures", async () => {
    const { rest, postMock } = makeDiscordRest();
    const error = Object.assign(new Error("Internal Server Error"), { status: 500 });
    postMock.mockRejectedValue(error);

    await expect(
      sendMessageDiscord("channel:789", "report", {
        ...discordClientOpts(rest),
        mediaUrl: "file:///tmp/report.pdf",
        retry: { attempts: 1 },
      }),
    ).rejects.toBe(error);
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("preserves caption and caller media options in the uploaded attachment", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg", channel_id: "789" });
    await sendMessageDiscord("channel:789", "  spaced  ", {
      ...discordClientOpts(rest),
      cfg: { channels: { discord: { mediaMaxMb: 32 } } },
      mediaUrl: "chart.png",
      filename: "renderable.png",
      mediaAccess: { workspaceDir: "/tmp/agent-workspace" },
    });
    const body = requireRestBody(postMock);
    expect(body).toHaveProperty("content", "  spaced  ");
    expectBodyFileName(body, "renderable.png");
    expect(loadWebMedia).toHaveBeenCalledWith("chart.png", {
      maxBytes: 32 * 1024 * 1024,
      workspaceDir: "/tmp/agent-workspace",
    });
  });

  it("preserves reusable replies across the attachment and its text continuation", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock
      .mockResolvedValueOnce({ id: "msg1", channel_id: "789" })
      .mockResolvedValueOnce({ id: "msg2", channel_id: "789" });
    const result = await sendMessageDiscord("channel:789", "a".repeat(2500), {
      ...discordClientOpts(rest),
      reply: { messageId: "orig-123", scope: "all" },
      mediaUrl: "file:///tmp/photo.jpg",
    });
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(result.receipt.parts.map(({ kind }) => kind)).toEqual(["media", "text"]);
    expectReplyReference(requireRestBody(postMock, 0), "orig-123");
    expectReplyReference(requireRestBody(postMock, 1), "orig-123");
  });
});

describe("reactMessageDiscord", () => {
  it.each([
    {
      name: "normalizes variation selectors in unicode emoji",
      emoji: "⭐️",
      encoded: "%E2%AD%90",
    },
    {
      name: "reacts with custom emoji syntax",
      emoji: "<:party_blob:123>",
      encoded: "party_blob%3A123",
    },
  ])("$name", async ({ emoji, encoded }) => {
    const { rest, putMock } = makeDiscordRest();
    await reactMessageDiscord("chan1", "1", emoji, {
      ...discordClientOpts(rest),
      accountId: "default",
    });
    expect(putMock).toHaveBeenCalledWith(Routes.channelMessageOwnReaction("chan1", "1", encoded));
  });
});

describe("removeReactionDiscord", () => {
  it("retries transient failures while removing an idempotent reaction", async () => {
    const { rest, deleteMock } = makeDiscordRest();
    deleteMock
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce(undefined);

    await expect(
      removeReactionDiscord("chan1", "1", "✅", {
        ...discordClientOpts(rest),
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).resolves.toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });
});

describe("removeOwnReactionsDiscord", () => {
  it("removes only owned unicode and custom reactions without repeating emoji", async () => {
    const { rest, getMock, deleteMock } = makeDiscordRest();
    getMock.mockResolvedValue({
      reactions: [
        { me: false, emoji: { name: "👀", id: null } },
        { me: true, emoji: { name: "✅", id: null } },
        { me: true, emoji: { name: "✅", id: null } },
        { me: true, emoji: { name: "party_blob", id: "123" } },
        { me: false, emoji: { name: "other_blob", id: "456" } },
      ],
    });
    const res = await removeOwnReactionsDiscord("chan1", "1", {
      ...discordClientOpts(rest),
      accountId: "default",
    });
    expect(res).toEqual({ ok: true, removed: ["✅", "party_blob:123"] });
    expect(deleteMock).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("chan1", "1", "%E2%9C%85"),
    );
    expect(deleteMock).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("chan1", "1", "party_blob%3A123"),
    );
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });

  it("does not send removal requests when all reactions belong to other users", async () => {
    const { rest, getMock, deleteMock } = makeDiscordRest();
    getMock.mockResolvedValue({
      reactions: [
        { me: false, emoji: { name: "👀", id: null } },
        { me: false, emoji: { name: "other_blob", id: "456" } },
      ],
    });

    await expect(
      removeOwnReactionsDiscord("chan1", "1", { rest, token: "t", cfg: DISCORD_TEST_CFG }),
    ).resolves.toEqual({ ok: true, removed: [] });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed deletion instead of reporting false success", async () => {
    const { rest, getMock, deleteMock } = makeDiscordRest();
    getMock.mockResolvedValue({
      reactions: [
        { me: true, emoji: { name: "✅", id: null } },
        { me: true, emoji: { name: "party_blob", id: "123" } },
      ],
    });
    const apiError = new Error("Discord API 500");
    deleteMock.mockResolvedValueOnce(undefined);
    deleteMock.mockRejectedValueOnce(apiError);
    await expect(
      removeOwnReactionsDiscord("chan1", "1", { rest, token: "t", cfg: DISCORD_TEST_CFG }),
    ).rejects.toThrow("Discord API 500");
    // Both deletions are still attempted; the rejection just propagates.
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchReactionsDiscord", () => {
  it("returns reactions with users", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock
      .mockResolvedValueOnce({
        reactions: [
          { count: 2, emoji: { name: "✅", id: null } },
          { count: 1, emoji: { name: "party_blob", id: "123" } },
        ],
      })
      .mockResolvedValueOnce([{ id: "u1", username: "alpha", discriminator: "0001" }])
      .mockResolvedValueOnce([{ id: "u2", username: "beta" }]);
    const res = await fetchReactionsDiscord("chan1", "1", {
      ...discordClientOpts(rest),
      accountId: "default",
    });
    expect(res).toEqual([
      {
        emoji: { id: null, name: "✅", raw: "✅" },
        count: 2,
        users: [{ id: "u1", username: "alpha", tag: "alpha#0001" }],
      },
      {
        emoji: { id: "123", name: "party_blob", raw: "party_blob:123" },
        count: 1,
        users: [{ id: "u2", username: "beta", tag: "beta" }],
      },
    ]);
  });
});

describe("Discord channel permissions", () => {
  it("uses parent overwrites for thread diagnostics", async () => {
    const { rest, getMock } = permissionFixture({
      type: ChannelType.PublicThread,
      permissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessagesInThreads,
      overwrites: [overwrite("guild1", PermissionFlagsBits.ViewChannel)],
      bot: true,
    });
    const res = await fetchChannelPermissionsDiscord("chan1", discordClientOpts(rest));
    expect(res).toMatchObject({
      channelId: "chan1",
      guildId: "guild1",
      channelType: ChannelType.PublicThread,
      isDm: false,
      raw: PermissionFlagsBits.SendMessagesInThreads.toString(),
    });
    expect(res.permissions).toEqual(["SendMessagesInThreads"]);
    expect(getMock.mock.calls.map(([route]) => route)).toEqual([
      Routes.channel("chan1"),
      Routes.channel("parent1"),
      Routes.user("@me"),
      Routes.guild("guild1"),
      Routes.guildMember("guild1", "user1"),
    ]);
  });

  it("stops permission lookup when the caller deadline aborts", async () => {
    const { rest, getMock } = makeDiscordRest();
    const controller = new AbortController();
    getMock.mockImplementationOnce(async () => {
      controller.abort();
      return { id: "chan1", guild_id: "guild1", permission_overwrites: [] };
    });
    await expect(
      fetchChannelPermissionsDiscord("chan1", {
        ...discordClientOpts(rest),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("treats Administrator as all permissions despite overwrites", async () => {
    const { rest } = permissionFixture({
      permissions: PermissionFlagsBits.Administrator,
      overwrites: [overwrite("guild1", PermissionFlagsBits.ViewChannel)],
      bot: true,
    });
    const res = await fetchChannelPermissionsDiscord("chan1", discordClientOpts(rest));
    expect(res.permissions).toContain("Administrator");
    expect(res.permissions).toContain("ViewChannel");
  });

  it("aggregates conflicting role overwrites before applying allows", async () => {
    const { rest } = permissionFixture({
      roles: ["role-allow", "role-deny"],
      overwrites: [
        overwrite("guild1", PermissionFlagsBits.ViewChannel),
        overwrite("role-allow", 0n, PermissionFlagsBits.ViewChannel),
        overwrite("role-deny", PermissionFlagsBits.ViewChannel),
      ],
    });
    await expect(
      canViewDiscordGuildChannel("guild1", "chan1", "user1", discordClientOpts(rest)),
    ).resolves.toBe(true);
  });

  it.each([
    {
      name: "parent deny applies to public threads",
      type: ChannelType.PublicThread,
      denied: true,
      moderator: false,
      membership: "none",
      expected: false,
      calls: 4,
    },
    {
      name: "private threads require membership",
      type: ChannelType.PrivateThread,
      denied: false,
      moderator: false,
      membership: "member",
      expected: true,
      calls: 5,
    },
    {
      name: "missing private-thread membership fails closed",
      type: ChannelType.PrivateThread,
      denied: false,
      moderator: false,
      membership: "missing",
      expected: false,
      calls: 5,
    },
    {
      name: "moderators bypass private-thread membership",
      type: ChannelType.PrivateThread,
      denied: false,
      moderator: true,
      membership: "none",
      expected: true,
      calls: 4,
    },
  ])("$name", async ({ type, denied, moderator, membership, expected, calls }) => {
    const { rest, getMock } = permissionFixture({
      type,
      permissions:
        PermissionFlagsBits.ViewChannel | (moderator ? PermissionFlagsBits.ManageThreads : 0n),
      overwrites: denied ? [overwrite("user1", PermissionFlagsBits.ViewChannel)] : [],
    });
    if (membership === "member") {
      getMock.mockResolvedValueOnce({ id: "chan1", user_id: "user1" });
    }
    if (membership === "missing") {
      getMock.mockRejectedValueOnce(new Error("404 Unknown Member"));
    }
    await expect(
      canViewDiscordGuildChannel("guild1", "chan1", "user1", discordClientOpts(rest)),
    ).resolves.toBe(expected);
    expect(getMock).toHaveBeenCalledTimes(calls);
    if (membership === "member") {
      expect(getMock).toHaveBeenLastCalledWith(Routes.threadMembers("chan1", "user1"));
    }
  });

  it("fails closed when the channel belongs to a different guild", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ id: "chan1", guild_id: "guild2", permission_overwrites: [] });
    await expect(
      canViewDiscordGuildChannel("guild1", "chan1", "user1", discordClientOpts(rest)),
    ).resolves.toBe(false);
  });
});

describe("edit/delete message helpers", () => {
  it("edits message content", async () => {
    const { rest, patchMock } = makeDiscordRest();
    patchMock.mockResolvedValue({ id: "m1" });
    await editMessageDiscord(
      "chan1",
      "1",
      { content: "hello" },
      { rest, token: "t", cfg: DISCORD_TEST_CFG },
    );
    expectRestRoute(patchMock, 0, Routes.channelMessage("chan1", "1"));
    expect(requireRestBody(patchMock).content).toBe("hello");
  });

  it("deletes message", async () => {
    const { rest, deleteMock } = makeDiscordRest();
    deleteMock.mockResolvedValue({});
    await deleteMessageDiscord("chan1", "1", { rest, token: "t", cfg: DISCORD_TEST_CFG });
    expect(deleteMock).toHaveBeenCalledWith(Routes.channelMessage("chan1", "1"));
  });
});

describe("pin helpers", () => {
  it("pins and unpins messages", async () => {
    const { rest, putMock, deleteMock } = makeDiscordRest();
    putMock.mockResolvedValue({});
    deleteMock.mockResolvedValue({});
    await pinMessageDiscord("chan1", "1", { rest, token: "t", cfg: DISCORD_TEST_CFG });
    await unpinMessageDiscord("chan1", "1", { rest, token: "t", cfg: DISCORD_TEST_CFG });
    expect(putMock).toHaveBeenCalledWith(Routes.channelPin("chan1", "1"));
    expect(deleteMock).toHaveBeenCalledWith(Routes.channelPin("chan1", "1"));
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
