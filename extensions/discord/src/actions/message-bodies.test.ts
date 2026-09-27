import { createServer, type Server } from "node:http";
import type { ChannelProgressDraftCompositorSnapshot } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discordMessageActions } from "../channel-actions.js";
import { RequestClient } from "../internal/rest.js";
import { sendDiscordComponentMessage } from "../send.components.js";
import * as runtime from "../send.js";
import { sendPollDiscord, sendStickerDiscord } from "../send.outbound.js";
import { handleDiscordMessageAction } from "./handle-action.js";
import { handleDiscordAction } from "./runtime.js";

vi.mock("../send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../send.js")>();
  return {
    ...actual,
    editMessageDiscord: vi.fn(actual.editMessageDiscord),
    deleteMessageDiscord: vi.fn(actual.deleteMessageDiscord),
    fetchChannelInfoDiscord: vi.fn(actual.fetchChannelInfoDiscord),
    fetchGuildInfoDiscord: vi.fn(actual.fetchGuildInfoDiscord),
    sendMessageDiscord: vi.fn(actual.sendMessageDiscord),
    sendStickerDiscord: vi.fn(actual.sendStickerDiscord),
    createThreadDiscord: vi.fn(actual.createThreadDiscord),
  };
});

vi.mock("../send.components.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../send.components.js")>();
  return { ...actual, sendDiscordComponentMessage: vi.fn(actual.sendDiscordComponentMessage) };
});

const originalComponents =
  await vi.importActual<typeof import("../send.components.js")>("../send.components.js");

const channelId = "123456789012345678";
const messageId = "223456789012345678";
const guildId = "323456789012345678";
const threadId = "623456789012345678";
const token = "synthetic-message-body-token";
const attachment = { id: "423456789012345678", filename: "example.txt", size: 4 };
const cfg: OpenClawConfig = {
  channels: { discord: { token, groupPolicy: "open" } },
};
const original = await vi.importActual<typeof import("../send.js")>("../send.js");
const originalFetch = globalThis.fetch;
let server: Server;
let rest: RequestClient;
let requests: { method: string; path: string; body: Record<string, unknown> }[];
let current: { content: string; attachments: (typeof attachment)[] };
let unexpectedUrls: string[];
let parentChannelType: number;
let threadMessageIds: string[];

beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      expect(request.headers.authorization).toBe(`Bot ${token}`);
      const parts: Buffer[] = [];
      for await (const part of request) {
        parts.push(Buffer.from(part));
      }
      const body = JSON.parse(Buffer.concat(parts).toString() || "{}") as Record<string, unknown>;
      const method = request.method ?? "";
      const path = request.url ?? "";
      requests.push({ method, path, body });
      if (method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      if (method === "PATCH") {
        current = { ...current, ...body };
      }
      let result: Record<string, unknown> =
        method === "GET"
          ? path.startsWith("/v10/guilds/")
            ? { id: guildId, name: "synthetic-guild" }
            : {
                id: channelId,
                type: parentChannelType,
                ...(parentChannelType === 1 ? {} : { guild_id: guildId }),
                name: "synthetic-channel",
              }
          : { id: messageId, channel_id: channelId, ...current, ...body };
      if (method === "POST" && path.endsWith("/threads")) {
        result = {
          id: threadId,
          type: 11,
          name: body.name,
          message_count: 0,
          total_message_sent: 0,
          last_message_id: null,
        };
        if (body.message) {
          threadMessageIds.push(messageId);
          result.message = { id: messageId, channel_id: threadId };
        }
      } else if (method === "POST" && path === `/v10/channels/${threadId}/messages`) {
        const id = String(BigInt(messageId) + BigInt(threadMessageIds.length));
        threadMessageIds.push(id);
        result = { id, channel_id: threadId, ...body };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP fixture did not bind a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== baseUrl) {
      unexpectedUrls.push(url.href);
      throw new Error("HTTP fixture refused a request outside its loopback server");
    }
    return originalFetch(input, init);
  });
  rest = new RequestClient(token, { baseUrl, timeout: 5000 });
  vi.mocked(runtime.editMessageDiscord).mockImplementation((channel, id, payload, opts) =>
    original.editMessageDiscord(channel, id, payload, { ...opts, rest }),
  );
  vi.mocked(runtime.deleteMessageDiscord).mockImplementation((channel, id, opts) =>
    original.deleteMessageDiscord(channel, id, { ...opts, rest }),
  );
  vi.mocked(runtime.fetchChannelInfoDiscord).mockImplementation((channel, opts) =>
    original.fetchChannelInfoDiscord(channel, { ...opts, rest }),
  );
  vi.mocked(runtime.fetchGuildInfoDiscord).mockImplementation((guild, opts) =>
    original.fetchGuildInfoDiscord(guild, { ...opts, rest }),
  );
  vi.mocked(runtime.sendMessageDiscord).mockImplementation((to, content, opts) =>
    original.sendMessageDiscord(to, content, { ...opts, rest }),
  );
  vi.mocked(sendDiscordComponentMessage).mockImplementation((to, spec, opts) =>
    originalComponents.sendDiscordComponentMessage(to, spec, { ...opts, rest }),
  );
  vi.mocked(runtime.sendStickerDiscord).mockImplementation((to, ids, opts) =>
    original.sendStickerDiscord(to, ids, { ...opts, rest }),
  );
  vi.mocked(runtime.createThreadDiscord).mockImplementation((channel, payload, opts) =>
    original.createThreadDiscord(channel, payload, { ...opts, rest }),
  );
});

beforeEach(() => {
  requests = [];
  unexpectedUrls = [];
  parentChannelType = 0;
  threadMessageIds = [];
  current = { content: "Initial caption", attachments: [attachment] };
});

afterEach(() => {
  expect(unexpectedUrls).toEqual([]);
});

afterAll(async () => {
  for (const mock of [
    runtime.editMessageDiscord,
    runtime.deleteMessageDiscord,
    runtime.fetchChannelInfoDiscord,
    runtime.fetchGuildInfoDiscord,
    runtime.sendMessageDiscord,
    sendDiscordComponentMessage,
    runtime.sendStickerDiscord,
    runtime.createThreadDiscord,
  ]) {
    vi.mocked(mock).mockReset();
  }
  vi.restoreAllMocks();
  rest?.abortAllRequests();
  server?.closeAllConnections();
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

const writes = () => requests.filter((request) => request.method !== "GET");

describe("Discord retained progress edits", () => {
  it("edits the same checklist with account-scoped rendering and inert mentions", async () => {
    const snapshot: ChannelProgressDraftCompositorSnapshot = {
      label: "Working",
      statusHeadline: "Waiting @everyone for child verification",
      statusHeadlineFormat: "plain",
      lines: ["Child verifier: checks passed"],
      plan: [
        { step: "Inspect source and configuration", status: "completed" },
        { step: "Verify the child result", status: "in_progress" },
      ],
    };
    const accountCfg: OpenClawConfig = {
      channels: {
        discord: {
          token,
          groupPolicy: "disabled",
          streaming: { progress: { maxLines: 1, maxLineChars: 8 } },
          accounts: {
            worker: {
              groupPolicy: "open",
              streaming: {
                mode: "progress",
                progress: { toolProgress: true, maxLines: 3, maxLineChars: 120 },
              },
            },
          },
        },
      },
    };
    await discordMessageActions.handleAction?.({
      channel: "discord",
      action: "edit",
      cfg: accountCfg,
      accountId: "worker",
      params: {
        to: `channel:${threadId}`,
        messageId,
        message: "Generic fallback must not replace the retained card.",
      },
      progressSnapshot: snapshot,
      conversationReadOrigin: "direct-operator",
    });

    expect(writes()).toEqual([
      {
        method: "PATCH",
        path: `/v10/channels/${threadId}/messages/${messageId}`,
        body: {
          content: expect.stringContaining("Inspect source and configuration"),
          allowed_mentions: { parse: [] },
        },
      },
    ]);
    expect(current.content).toContain("Child verifier: checks passed");
    expect(current.content).toContain("Verify the child result");
    expect(current.content).not.toContain("Generic fallback");
    expect(current.attachments).toEqual([attachment]);
  });

  it("bounds a retained edit to one configured Discord message", async () => {
    await discordMessageActions.handleAction?.({
      channel: "discord",
      action: "edit",
      cfg: {
        channels: {
          discord: {
            token,
            groupPolicy: "open",
            textChunkLimit: 100,
            streaming: { progress: { maxLineChars: 1000 } },
          },
        },
      },
      params: { to: `channel:${channelId}`, messageId, message: "Generic fallback" },
      progressSnapshot: { lines: ["Child verifier: " + "result ".repeat(500)] },
      conversationReadOrigin: "direct-operator",
    });

    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      method: "PATCH",
      path: `/v10/channels/${channelId}/messages/${messageId}`,
      body: { allowed_mentions: { parse: [] } },
    });
    expect(current.content).toContain("Child verifier:");
    expect(current.content.length).toBeLessThanOrEqual(100);
  });

  it.each([true, false])(
    "uses the current DM channel only for its captured user target (matching: %s)",
    async (matching) => {
      parentChannelType = 1;
      const editing = discordMessageActions.handleAction?.({
        channel: "discord",
        action: "edit",
        cfg,
        accountId: "default",
        requesterAccountId: "default",
        params: { to: "user:523456789012345678", messageId, message: "Generic fallback" },
        progressSnapshot: { lines: [], plan: [{ step: "Verify", status: "in_progress" }] },
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: channelId,
          currentMessagingTarget: `user:${matching ? "523456789012345678" : "523456789012345679"}`,
          currentChatType: "direct",
        },
      });
      if (!matching) {
        await expect(editing).rejects.toThrow();
        expect(writes()).toEqual([]);
        return;
      }
      await editing;

      expect(writes()).toEqual([
        {
          method: "PATCH",
          path: `/v10/channels/${channelId}/messages/${messageId}`,
          body: { content: "▸ Verify", allowed_mentions: { parse: [] } },
        },
      ]);
    },
  );

  it("fences a retained edit when its owner retires during target policy lookup", async () => {
    const started = createDeferred<void>();
    const resume = createDeferred<void>();
    vi.mocked(runtime.fetchChannelInfoDiscord).mockImplementationOnce(async (id, options) => {
      const channel = await original.fetchChannelInfoDiscord(id, { ...options, rest });
      started.resolve();
      await resume.promise;
      return channel;
    });
    let authorized = true;
    const editing = discordMessageActions.handleAction?.({
      channel: "discord",
      action: "edit",
      cfg,
      params: { to: `channel:${channelId}`, messageId, message: "Generic fallback" },
      progressSnapshot: { lines: [], plan: [{ step: "Verify", status: "in_progress" }] },
      conversationReadOrigin: "direct-operator",
      assertDirectAdapterHandoff: () => {
        if (!authorized) {
          throw new Error("Progress owner retired");
        }
      },
    });
    await started.promise;
    authorized = false;
    resume.resolve();

    await expect(editing).rejects.toThrow("Progress owner retired");
    expect(writes()).toEqual([]);
    expect(current.content).toBe("Initial caption");
  });
});

describe.each(["runtime", "adapter"] as const)("Discord %s message bodies", (entry) => {
  const send = (content: unknown, extra: Record<string, unknown> = {}) =>
    entry === "runtime"
      ? handleDiscordAction(
          { action: "sendMessage", to: ` channel:${channelId} `, content, ...extra },
          cfg,
        )
      : handleDiscordMessageAction({
          action: "send",
          params: { to: ` channel:${channelId} `, message: content, ...extra },
          cfg,
        });
  const edit = (content: unknown, config = cfg, id: unknown = messageId) =>
    entry === "runtime"
      ? handleDiscordAction({ action: "editMessage", channelId, messageId: id, content }, config, {
          conversationReadOrigin: "direct-operator",
        })
      : handleDiscordMessageAction({
          action: "edit",
          params: { to: `channel:${channelId}`, messageId: id, message: content },
          cfg: config,
          conversationReadOrigin: "direct-operator",
        });

  const createThread = (content?: string) =>
    entry === "runtime"
      ? handleDiscordAction({ action: "threadCreate", channelId, name: "example", content }, cfg)
      : handleDiscordMessageAction({
          action: "thread-create",
          params: { channelId, threadName: "example", message: content },
          cfg,
        });

  it.each([
    [0, "hello", 1],
    [0, "a".repeat(2001), 2],
    [15, "hello", 1],
    [15, "a".repeat(2001), 2],
    [16, undefined, 1],
  ] as const)(
    "reports confirmed initial delivery for parent type %i (case %#)",
    async (type, content, chunkCount) => {
      parentChannelType = type;
      const result = await createThread(content);
      expect(threadMessageIds).toHaveLength(chunkCount);
      expect(result.details).toMatchObject({
        ok: true,
        threadSnapshot: "creation",
        thread: { id: threadId, message_count: 0, total_message_sent: 0, last_message_id: null },
        initialMessageDelivery: {
          status: "delivered",
          starterMessageDelivered: type !== 0,
          deliveredChunkCount: chunkCount,
          totalChunkCount: chunkCount,
          deliveredMessageIds: threadMessageIds,
        },
      });
      const text = result.content.find((block) => block.type === "text");
      expect(text?.type === "text" ? JSON.parse(text.text) : undefined).toEqual(result.details);
      expect(requests.filter((request) => request.method === "GET")).toHaveLength(1);
    },
  );

  it("does not report initial delivery for an empty standalone thread", async () => {
    const result = await createThread();
    expect(threadMessageIds).toEqual([]);
    expect(result.details).not.toHaveProperty("initialMessageDelivery");
    expect(writes()).toHaveLength(1);
  });

  it.each(["Changed caption", "    console.log(1);\n", ""])(
    "edits exact content %j and retains attachments",
    async (content) => {
      await edit(content);
      expect(writes()).toEqual([
        {
          method: "PATCH",
          path: `/v10/channels/${channelId}/messages/${messageId}`,
          body: { content },
        },
      ]);
      expect(current).toEqual({ content, attachments: [attachment] });
    },
  );

  it.each([undefined, null, 42])(
    "rejects absent or non-string edit content %j without mutation",
    async (content) => {
      await expect(edit(content)).rejects.toThrow(/required/);
      expect(writes()).toEqual([]);
    },
  );

  it.each([null, "", "   "])("rejects missing message ID %j without mutation", async (id) => {
    await expect(edit("Changed caption", cfg, id)).rejects.toThrow(/required/);
    expect(writes()).toEqual([]);
  });

  it("normalizes identifiers without normalizing the message body", async () => {
    const content = "  Changed caption\n";
    await edit(content, cfg, ` ${messageId} `);
    expect(writes()).toEqual([
      {
        method: "PATCH",
        path: `/v10/channels/${channelId}/messages/${messageId}`,
        body: { content },
      },
    ]);
  });

  it("rejects malformed message IDs before a message mutation", async () => {
    await expect(edit("Changed caption", cfg, "..")).rejects.toThrow("Invalid Discord message ID");
    expect(writes()).toEqual([]);
  });

  it.each([undefined, null, 42])(
    "rejects plain sends without string content %j",
    async (content) => {
      await expect(send(content)).rejects.toThrow(/required/);
      expect(writes()).toEqual([]);
    },
  );

  it("delivers embeds without a text body", async () => {
    const embeds = [{ title: "Release notes", description: "Version available" }];
    await send(undefined, { embeds });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      method: "POST",
      path: `/v10/channels/${channelId}/messages`,
      body: { embeds },
    });
    expect(writes()[0]?.body).not.toHaveProperty("content");
  });

  it("delivers presentation text without a separate message body", async () => {
    const text = "-# Revenue (bar chart)\n- USD: Q1: 12; Q2: 18";
    await send(
      undefined,
      entry === "adapter"
        ? {
            presentation: {
              blocks: [
                {
                  type: "chart",
                  chartType: "bar",
                  title: "Revenue",
                  categories: ["Q1", "Q2"],
                  series: [{ name: "USD", values: [12, 18] }],
                },
              ],
            },
          }
        : { components: { blocks: [{ type: "text", text }] } },
    );
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      method: "POST",
      path: `/v10/channels/${channelId}/messages`,
      body: { components: [{ type: 17, components: [{ type: 10, content: text }] }] },
    });
    expect(writes()[0]?.body).not.toHaveProperty("content");
  });

  it("keeps disabled and blocked edit targets from mutating", async () => {
    await expect(
      edit("caption", { channels: { discord: { token, actions: { messages: false } } } }),
    ).rejects.toThrow(/disabled/);
    await expect(
      edit("caption", { channels: { discord: { token, groupPolicy: "disabled" } } }),
    ).rejects.toThrow(/not allowed/);
    expect(writes()).toEqual([]);
  });

  it("deletes the exact message through the same target projection", async () => {
    if (entry === "runtime") {
      await handleDiscordAction({ action: "deleteMessage", channelId, messageId }, cfg, {
        conversationReadOrigin: "direct-operator",
      });
    } else {
      await handleDiscordMessageAction({
        action: "delete",
        params: { to: `channel:${channelId}`, messageId },
        cfg,
        conversationReadOrigin: "direct-operator",
      });
    }
    expect(writes()).toEqual([
      { method: "DELETE", path: `/v10/channels/${channelId}/messages/${messageId}`, body: {} },
    ]);
  });

  it.each(["send", "thread-reply", "thread-create", "sticker"] as const)(
    "preserves indentation and trailing newline for %s",
    async (action) => {
      const content = "    console.log(1);\n";
      if (entry === "adapter") {
        await handleDiscordMessageAction({
          action,
          params: {
            to: `channel:${channelId}`,
            channelId,
            threadId: channelId,
            threadName: "example",
            message: content,
            stickerId: ["523456789012345678"],
          },
          cfg,
        });
      } else {
        const actions = {
          send: "sendMessage",
          "thread-reply": "threadReply",
          "thread-create": "threadCreate",
          sticker: "sticker",
        };
        await handleDiscordAction(
          {
            action: actions[action],
            to: `channel:${channelId}`,
            channelId,
            name: "example",
            content,
            stickerIds: ["523456789012345678"],
          },
          cfg,
        );
      }
      const messages = writes().filter((request) => request.path.endsWith("/messages"));
      expect(messages).toHaveLength(1);
      expect(messages[0]?.body.content).toBe(content);
    },
  );
});

describe.each(["sticker", "poll"] as const)("Discord structured %s content", (kind) => {
  it.each([
    [undefined, undefined],
    [" \n", undefined],
    ["Caption", "Caption"],
    ["  Caption\n", "  Caption\n"],
  ])("preserves optional content %j when nonblank", async (content, expected) => {
    const options = { cfg, rest, content };
    if (kind === "sticker") {
      await sendStickerDiscord(`channel:${channelId}`, ["523456789012345678"], options);
    } else {
      await sendPollDiscord(
        `channel:${channelId}`,
        { question: "Lunch?", options: ["Pizza", "Sushi"] },
        options,
      );
    }
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body.content).toBe(expected);
    expect(writes()[0]?.body).toHaveProperty(kind === "sticker" ? "sticker_ids" : "poll");
  });
});

// Background task publishers have a captured dispatch owner, not a fresh inbound message.
describe("Discord background progress edits", () => {
  it.each([false, true])(
    "retains the original edit authority across channel lookup (revoked=%s)",
    async (revokeAfterLookup) => {
      let active = true;
      const assertCurrent = () => {
        if (!active) {
          throw new Error("background progress owner revoked");
        }
      };
      vi.mocked(runtime.fetchChannelInfoDiscord).mockImplementationOnce(async (channel, opts) => {
        const info = await original.fetchChannelInfoDiscord(channel, { ...opts, rest });
        if (revokeAfterLookup) {
          active = false;
        }
        return info;
      });
      const pending = handleDiscordMessageAction({
        action: "edit",
        accountId: "default",
        params: {
          to: `channel:${channelId}`,
          messageId,
          message: "Background work: waiting for approval. Last activity: 12:00 UTC.",
        },
        cfg: {
          channels: {
            discord: {
              token,
              groupPolicy: "allowlist",
              guilds: { [guildId]: { channels: { [channelId]: { enabled: true } } } },
            },
          },
        },
        assertDirectAdapterHandoff: assertCurrent,
      });
      if (revokeAfterLookup) {
        await expect(pending).rejects.toThrow(/revoked/);
        expect(writes()).toEqual([]);
      } else {
        await pending;
        expect(writes()).toEqual([
          {
            method: "PATCH",
            path: `/v10/channels/${channelId}/messages/${messageId}`,
            body: { content: "Background work: waiting for approval. Last activity: 12:00 UTC." },
          },
        ]);
      }
    },
  );
});
