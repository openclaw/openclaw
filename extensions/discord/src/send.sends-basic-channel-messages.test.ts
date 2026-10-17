import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  Routes,
  type APIMessageTopLevelComponent,
} from "discord-api-types/v10";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Container, TextDisplay } from "./internal/components.message.js";
import {
  createDiscordLoopbackRest,
  discordWebMediaMockFactory,
  makeDiscordRest,
  requestBody,
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

async function loopbackRest(options?: Parameters<typeof createDiscordLoopbackRest>[0]) {
  const loopback = await createDiscordLoopbackRest(options);
  onTestFinished(loopback.close);
  return loopback;
}

const retry = { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };
const reaction = (me: boolean, name: string, id: string | null = null) => ({
  me,
  emoji: { name, id },
});
function expectAbsent(value: unknown, ...keys: string[]) {
  for (const key of keys) {
    expect(value).not.toHaveProperty(key);
  }
}
function deliveryAuthority() {
  let active = true;
  const error = new Error("delivery authority revoked");
  const check = () => {
    if (!active) {
      throw error;
    }
  };
  return {
    error,
    check,
    dispatch: vi.fn(async () => check()),
    revoke: () => {
      active = false;
    },
  };
}

const DISCORD_TEST_CFG = {
  channels: { discord: { token: "t" } },
};

function clientOptions(rest: ReturnType<typeof makeDiscordRest>["rest"]) {
  return { rest, token: "t", cfg: DISCORD_TEST_CFG };
}

function sendHarness() {
  const mocks = makeDiscordRest();
  return {
    ...mocks,
    send: (
      text: string,
      options: Parameters<typeof sendMessageDiscord>[2] = {},
      to = "channel:789",
    ) => sendMessageDiscord(to, text, { ...clientOptions(mocks.rest), ...options }),
  };
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
    name: "keeps indentation and special link destinations byte-identical",
    before:
      '    a\n    b\n\n[x](<https://example.test/__v1__/a)>)\n<https://example.test/__v1__/>\nhttps://example.test/__v1__/bare\n<:__wave__:123456789012345678> <a:__dance__:123456789012345679> </__foo__:123456789012345680>\n\n[r]: https://example.test/__v1__/unused\n  "__title__"',
    after:
      '    a\n    b\n\n[x](<https://example.test/__v1__/a)>)\n<https://example.test/__v1__/>\nhttps://example.test/__v1__/bare\n<:__wave__:123456789012345678> <a:__dance__:123456789012345679> </__foo__:123456789012345680>\n\n[r]: https://example.test/__v1__/unused\n  "__title__"',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  clearDiscordDirectoryCacheForTest();
});

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
  it("sends embed-only messages with a card receipt and enforced nonce", async () => {
    const { send, postMock, getMock } = sendHarness();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "embed1", channel_id: "789" });
    const onDeliveryResult = vi.fn();
    const result = await send("", {
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
    expect(requestBody(postMock)).toMatchObject({
      embeds: [{ title: "Release notes", description: "Version available" }],
      allowed_mentions: { parse: [] },
      message_reference: { message_id: "orig-123", fail_if_not_exists: false },
      enforce_nonce: true,
    });
    expectAbsent(requestBody(postMock), "content", "flags");
  });

  it("keeps native components and embeds on the first message chunk only", async () => {
    const { send, postMock, getMock } = sendHarness();
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
    const result = await send("a".repeat(2_500), {
      components,
      embeds: [{ title: "Release notes" }],
      reply: { messageId: "orig-123", scope: "first" },
      onDeliveryResult,
      silent: true,
    });
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(requestBody(postMock, 0)).toMatchObject({
      components,
      embeds: [{ title: "Release notes" }],
      message_reference: { message_id: "orig-123", fail_if_not_exists: false },
    });
    expect(requestBody(postMock, 0).flags).toBe(MessageFlags.SuppressNotifications);
    expect(requestBody(postMock, 1).flags).toBe(
      MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications,
    );
    expectAbsent(requestBody(postMock, 1), "components", "embeds", "message_reference");
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.receipt.parts[0]?.kind)).toEqual([
      "card",
      "text",
    ]);
    expect(result.receipt).toMatchObject({
      replyToId: "orig-123",
      parts: [
        { kind: "card", replyToId: "orig-123" },
        { kind: "text", replyToId: undefined },
      ],
    });
  });

  it("rejects empty messages with an empty component factory", async () => {
    const { send, postMock, getMock } = sendHarness();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    await expect(send("", { components: () => [] })).rejects.toThrow(
      "Message must be non-empty for Discord sends",
    );
    expect(postMock).not.toHaveBeenCalled();
  });

  it.each(DISCORD_MARKDOWN_GOLDENS)("$name", async ({ before, after }) => {
    const { send, postMock, getMock } = sendHarness();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });
    await send(before);
    expect(requestBody(postMock).content).toBe(after);
  });

  it("sends a pre-sized fenced media tail once", async () => {
    let messageCount = 0;
    const loopback = await loopbackRest({
      respond: (request) =>
        request.method === "GET"
          ? { id: "789", type: ChannelType.GuildText }
          : { id: `message-${++messageCount}`, channel_id: "789" },
    });
    const body = "abc ".repeat(14);
    const onDeliveryResult = vi.fn();
    const result = await sendMessageDiscord("channel:789", `\`\`\`txt\n${body}\n\`\`\``, {
      ...clientOptions(loopback.rest),
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
  });

  it.each(["delivery callback", "later text send"])(
    "does not retry accepted media when its %s raises an upload error",
    async (failure) => {
      const { send, postMock } = sendHarness();
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
        send("a".repeat(2500), {
          mediaUrl: "file:///tmp/photo.jpg",
          onDeliveryResult,
        }),
      ).rejects.toBe(error);
      expect(postMock).toHaveBeenCalledTimes(failure === "delivery callback" ? 1 : 2);
      expect(onDeliveryResult.mock.calls.map(([part]) => part.messageId)).toEqual(["media-1"]);
    },
  );

  it.each(["media follow-up", "text retry", "dispatch refresh"] as const)(
    "rechecks delivery authority before %s",
    async (mode) => {
      const authority = deliveryAuthority();
      const loopback = await loopbackRest({
        status: (request) => {
          if (mode === "text retry" && request.method === "POST") {
            authority.revoke();
            return 503;
          }
          return 200;
        },
      });
      const onDeliveryResult = vi.fn(async () => authority.revoke());
      const onPlatformSendDispatch =
        mode === "dispatch refresh"
          ? async () => {
              await Promise.resolve();
              authority.revoke();
            }
          : authority.dispatch;
      const text =
        mode === "media follow-up"
          ? "a".repeat(2500)
          : mode === "text retry"
            ? "retry once"
            : "must not send";
      await expect(
        sendMessageDiscord("channel:789", text, {
          ...clientOptions(loopback.rest),
          onPlatformSendDispatch,
          ...(mode === "media follow-up"
            ? { mediaUrl: "file:///tmp/photo.jpg", onDeliveryResult }
            : {}),
          ...(mode === "text retry" ? { retry } : {}),
          ...(mode === "dispatch refresh" ? { assertPlatformSendAuthorized: authority.check } : {}),
        }),
      ).rejects.toBe(authority.error);
      const requests = loopback.requests.filter((request) => request.method === "POST");
      expect(requests).toHaveLength(mode === "dispatch refresh" ? 0 : 1);
      if (mode !== "dispatch refresh") {
        expect(authority.dispatch).toHaveBeenCalledTimes(2);
      }
      if (mode === "media follow-up") {
        expect(onDeliveryResult).toHaveBeenCalledOnce();
        expect(requests[0]?.path).toContain("/channels/789/messages");
        expect(requests[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
      }
    },
  );

  it("uses configured defaultAccount for cached mention rewriting when accountId is omitted", async () => {
    rememberDiscordDirectoryUser({
      accountId: "work",
      userId: "222333444555666777",
      handles: ["Alice"],
    });
    const { send, postMock, getMock } = sendHarness();
    getMock.mockResolvedValueOnce({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({
      id: "msg1",
      channel_id: "789",
    });
    await send("ping @Alice.", {
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
    expect(requestPath(postMock, 0)).toBe(Routes.channelMessages("789"));
    expect(requestBody(postMock).content).toBe("ping <@222333444555666777>.");
    expect(requestBody(postMock).flags).toBe(MessageFlags.SuppressEmbeds);
  });

  it("auto-creates a forum thread when target is a Forum channel", async () => {
    const { send, postMock, getMock } = sendHarness();
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildForum,
      default_auto_archive_duration: 1440,
    });
    postMock.mockResolvedValue({
      id: "thread1",
      message: { id: "starter1", channel_id: "thread1" },
    });
    const res = await send("Discussion topic\nBody of the post", {}, "channel:forum1");
    expect(res).toMatchObject({
      messageId: "starter1",
      channelId: "thread1",
      receipt: {
        threadId: "thread1",
        platformMessageIds: ["starter1"],
        parts: [{ platformMessageId: "starter1", kind: "text" }],
      },
    });
    expect(requestPath(postMock, 0)).toBe(Routes.threads("forum1"));
    expect(requestBody(postMock)).toEqual({
      name: "Discussion topic",
      auto_archive_duration: 1440,
      message: {
        content: "Discussion topic\nBody of the post",
        flags: MessageFlags.SuppressEmbeds,
      },
    });
  });

  it("explains how to create a forum thread when the parent requires an applied tag", async () => {
    const { send, postMock, getMock } = sendHarness();
    getMock.mockResolvedValueOnce({
      type: ChannelType.GuildForum,
      flags: 1 << 4,
      available_tags: [{ id: "tag1", name: "Question", moderated: false }],
    });
    await expect(send("Discussion topic", {}, "channel:forum1")).rejects.toThrow(
      /thread-create with appliedTags/,
    );
    expect(postMock).not.toHaveBeenCalled();
  });

  it("starts DM when recipient is a user", async () => {
    const { send, postMock } = sendHarness();
    postMock
      .mockResolvedValueOnce({ id: "chan1" })
      .mockResolvedValueOnce({ id: "msg1", channel_id: "chan1" });
    const res = await send("hiya", {}, "user:123");
    expect(requestPath(postMock, 0)).toBe(Routes.userChannels());
    expect(requestBody(postMock, 0).recipient_id).toBe("123");
    expect(requestPath(postMock, 1)).toBe(Routes.channelMessages("chan1"));
    expect(requestBody(postMock, 1).content).toBe("hiya");
    expect(res.channelId).toBe("chan1");
  });

  it.each([
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
      sendMessageDiscord("channel:chan1", "hello", clientOptions(rest)),
    ).rejects.toMatchObject({
      missingPermissions: missing,
      discordCode: 50013,
      status: 403,
      message: expect.stringContaining(
        missing[0] ?? "permission check did not identify missing ViewChannel/SendMessages",
      ),
    });
  });

  it("preserves implicit reply scope and delivery progress in upload fallback chunks", async () => {
    const { send, postMock } = sendHarness();
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
    await send("a".repeat(2500), {
      mediaUrl: "file:///tmp/report.pdf",
      reply: { messageId: "orig-123", scope: "first" },
      onDeliveryResult,
      components: [new Container([new TextDisplay("Attachment controls")])],
      embeds: [{ title: "Attachment preview" }],
    });
    expect(postMock).toHaveBeenCalledTimes(3);
    expectBodyFileName(requestBody(postMock, 0), "photo.jpg");
    const fallbackBody = requestBody(postMock, 1);
    expectAbsent(fallbackBody, "files", "components", "embeds");
    expect(String(requestBody(postMock, 2).content)).toContain(
      "[Attachment skipped: Discord rejected the file as too large.]",
    );
    expect(requestBody(postMock, 1).message_reference).toEqual({
      message_id: "orig-123",
      fail_if_not_exists: false,
    });
    expect(requestBody(postMock, 2).message_reference).toBeUndefined();
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.messageId)).toEqual([
      "fallback-1",
      "fallback-2",
    ]);
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.receipt.parts[0]?.replyToId)).toEqual(
      ["orig-123", undefined],
    );
  });

  it("reports a media-only upload rejected with HTTP 413", async () => {
    const { send, postMock } = sendHarness();
    postMock
      .mockRejectedValueOnce(Object.assign(new Error("Bad Request"), { status: 413 }))
      .mockResolvedValueOnce({ id: "fallback-msg", channel_id: "789" });
    const res = await send("", {
      mediaUrl: "file:///tmp/photo.jpg",
    });
    expect(res.messageId).toBe("fallback-msg");
    expect(requestBody(postMock, 1).content).toBe(
      "Attachment skipped: Discord rejected the file as too large.",
    );
    expect(requestBody(postMock, 1)).not.toHaveProperty("files");
  });

  it("does not mask unrelated media upload failures", async () => {
    const { send, postMock } = sendHarness();
    const error = Object.assign(new Error("Internal Server Error"), { status: 500 });
    postMock.mockRejectedValue(error);
    await expect(
      send("report", {
        mediaUrl: "file:///tmp/report.pdf",
        retry: { attempts: 1 },
      }),
    ).rejects.toBe(error);
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("preserves caption and caller media options in the uploaded attachment", async () => {
    const { send, postMock } = sendHarness();
    postMock.mockResolvedValue({ id: "msg", channel_id: "789" });
    await send("  spaced  ", {
      cfg: { channels: { discord: { mediaMaxMb: 32 } } },
      mediaUrl: "chart.png",
      filename: "renderable.png",
      mediaAccess: { workspaceDir: "/tmp/agent-workspace" },
    });
    const body = requestBody(postMock);
    expect(body).toHaveProperty("content", "  spaced  ");
    expectBodyFileName(body, "renderable.png");
    expect(loadWebMedia).toHaveBeenCalledWith("chart.png", {
      maxBytes: 32 * 1024 * 1024,
      workspaceDir: "/tmp/agent-workspace",
    });
  });
});

it("reacts with custom emoji syntax", async () => {
  const { rest, putMock } = makeDiscordRest();
  await reactMessageDiscord("chan1", "1", "<:party_blob:123>", {
    ...clientOptions(rest),
    accountId: "default",
  });
  expect(putMock).toHaveBeenCalledWith(
    Routes.channelMessageOwnReaction("chan1", "1", "party_blob%3A123"),
  );
});

describe("removeReactionDiscord", () => {
  it("retries transient failures while removing an idempotent reaction", async () => {
    const { rest, deleteMock } = makeDiscordRest();
    deleteMock
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce(undefined);
    await expect(
      removeReactionDiscord("chan1", "1", "✅", {
        ...clientOptions(rest),
        retry,
      }),
    ).resolves.toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });
});

describe("removeOwnReactionsDiscord", () => {
  it.each([
    {
      name: "mixed ownership and duplicate emoji",
      reactions: [
        reaction(false, "👀"),
        reaction(true, "✅"),
        reaction(true, "✅"),
        reaction(true, "party_blob", "123"),
        reaction(false, "other_blob", "456"),
      ],
      removed: ["✅", "party_blob:123"],
      routes: ["%E2%9C%85", "party_blob%3A123"],
      accountId: "default",
    },
    {
      name: "only other users' reactions",
      reactions: [reaction(false, "👀"), reaction(false, "other_blob", "456")],
      removed: [],
      routes: [],
      accountId: undefined,
    },
  ])("removes only owned reactions: $name", async ({ reactions, removed, routes, accountId }) => {
    const { rest, getMock, deleteMock } = makeDiscordRest();
    getMock.mockResolvedValue({ reactions });
    await expect(
      removeOwnReactionsDiscord("chan1", "1", { ...clientOptions(rest), accountId }),
    ).resolves.toEqual({ ok: true, removed });
    expect(deleteMock).toHaveBeenCalledTimes(routes.length);
    for (const route of routes) {
      expect(deleteMock).toHaveBeenCalledWith(
        Routes.channelMessageOwnReaction("chan1", "1", route),
      );
    }
  });

  it("surfaces a failed deletion instead of reporting false success", async () => {
    const { rest, getMock, deleteMock } = makeDiscordRest();
    getMock.mockResolvedValue({
      reactions: [reaction(true, "✅"), reaction(true, "party_blob", "123")],
    });
    const apiError = new Error("Discord API 500");
    deleteMock.mockResolvedValueOnce(undefined);
    deleteMock.mockRejectedValueOnce(apiError);
    await expect(
      removeOwnReactionsDiscord("chan1", "1", { rest, token: "t", cfg: DISCORD_TEST_CFG }),
    ).rejects.toThrow("Discord API 500");
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
      ...clientOptions(rest),
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
  it("stops permission lookup when the caller deadline aborts", async () => {
    const { rest, getMock } = makeDiscordRest();
    const controller = new AbortController();
    getMock.mockImplementationOnce(async () => {
      controller.abort();
      return { id: "chan1", guild_id: "guild1", permission_overwrites: [] };
    });
    await expect(
      fetchChannelPermissionsDiscord("chan1", {
        ...clientOptions(rest),
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
    const res = await fetchChannelPermissionsDiscord("chan1", clientOptions(rest));
    expect(res.permissions).toEqual(expect.arrayContaining(["Administrator", "ViewChannel"]));
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
      canViewDiscordGuildChannel("guild1", "chan1", "user1", clientOptions(rest)),
    ).resolves.toBe(true);
  });

  it.each([
    ["parent deny", false, 4],
    ["member", true, 5],
    ["missing member", false, 5],
    ["moderator", true, 4],
  ] as const)("applies thread visibility for %s", async (mode, expected, calls) => {
    const { rest, getMock } = permissionFixture({
      type: mode === "parent deny" ? ChannelType.PublicThread : ChannelType.PrivateThread,
      permissions:
        PermissionFlagsBits.ViewChannel |
        (mode === "moderator" ? PermissionFlagsBits.ManageThreads : 0n),
      overwrites:
        mode === "parent deny" ? [overwrite("user1", PermissionFlagsBits.ViewChannel)] : [],
    });
    if (mode === "member") {
      getMock.mockResolvedValueOnce({ id: "chan1", user_id: "user1" });
    }
    if (mode === "missing member") {
      getMock.mockRejectedValueOnce(new Error("404 Unknown Member"));
    }
    await expect(
      canViewDiscordGuildChannel("guild1", "chan1", "user1", clientOptions(rest)),
    ).resolves.toBe(expected);
    expect(getMock).toHaveBeenCalledTimes(calls);
    if (mode === "member") {
      expect(getMock).toHaveBeenLastCalledWith(Routes.threadMembers("chan1", "user1"));
    }
  });

  it("fails closed when the channel belongs to a different guild", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({ id: "chan1", guild_id: "guild2", permission_overwrites: [] });
    await expect(
      canViewDiscordGuildChannel("guild1", "chan1", "user1", clientOptions(rest)),
    ).resolves.toBe(false);
  });
});

describe("message mutation retries", () => {
  const unknownMessage = Object.assign(new Error("Unknown Message"), {
    status: 404,
    discordCode: 10008,
  });
  const lostResponse = Object.assign(new Error("response lost"), { name: "AbortError" });
  const notConnected = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
  const mutations = [
    {
      name: "edit",
      mock: "patchMock",
      route: Routes.channelMessage("chan1", "1"),
      run: (opts: ReturnType<typeof clientOptions>) =>
        editMessageDiscord("chan1", "1", { content: "hello" }, opts),
    },
    {
      name: "delete",
      mock: "deleteMock",
      route: Routes.channelMessage("chan1", "1"),
      run: deleteMessageDiscord.bind(null, "chan1", "1"),
    },
    {
      name: "pin",
      mock: "putMock",
      route: Routes.channelPin("chan1", "1"),
      run: pinMessageDiscord.bind(null, "chan1", "1"),
    },
    {
      name: "unpin",
      mock: "deleteMock",
      route: Routes.channelPin("chan1", "1"),
      run: unpinMessageDiscord.bind(null, "chan1", "1"),
    },
  ] as const;

  it.each(mutations)("retries a transient $name failure", async ({ mock, route, run }) => {
    const mocks = makeDiscordRest();
    mocks[mock]
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce({ id: "m1" });
    await run({ ...clientOptions(mocks.rest), retry });
    expect(mocks[mock]).toHaveBeenCalledTimes(2);
    expect(requestPath(mocks[mock], 0)).toBe(route);
    expect(requestPath(mocks[mock], 1)).toBe(route);
    if (mock === "patchMock") {
      expect(requestBody(mocks[mock], 1).content).toBe("hello");
    }
  });

  it.each(mutations)("stops the $name retry when the caller aborts during backoff", async (m) => {
    vi.useFakeTimers();
    try {
      const mocks = makeDiscordRest();
      mocks[m.mock].mockRejectedValue(Object.assign(new Error("bad gateway"), { status: 502 }));
      const controller = new AbortController();
      const reason = new Error("caller aborted");
      const settled = expect(
        m.run({
          ...clientOptions(mocks.rest),
          retry: { attempts: 3, minDelayMs: 1_000, maxDelayMs: 1_000, jitter: 0 },
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);

      await vi.advanceTimersByTimeAsync(0);
      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(5_000);
      await settled;
      expect(mocks[m.mock]).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads Unknown Message from a real Discord error response", async () => {
    let calls = 0;
    const loopback = await loopbackRest({
      status: () => (++calls === 1 ? 502 : 404),
      respond: () =>
        calls === 1 ? { message: "Bad Gateway" } : { message: "Unknown Message", code: 10008 },
    });
    await expect(
      deleteMessageDiscord("chan1", "1", { ...clientOptions(loopback.rest), retry }),
    ).resolves.toEqual({ ok: true });
    expect(loopback.requests.map((request) => request.method)).toEqual(["DELETE", "DELETE"]);
  });

  it.each([
    ["on the first attempt", [unknownMessage]],
    ["after a failure that never reached Discord", [notConnected, unknownMessage]],
    [
      "for another 404 after a lost response",
      [lostResponse, Object.assign(new Error("Unknown Channel"), { status: 404 })],
    ],
  ])("still fails a delete with %s", async (_label, failures) => {
    const { rest, deleteMock } = makeDiscordRest();
    for (const failure of failures) {
      deleteMock.mockRejectedValueOnce(failure);
    }
    await expect(
      deleteMessageDiscord("chan1", "1", { ...clientOptions(rest), retry }),
    ).rejects.toBe(failures.at(-1));
  });
});
