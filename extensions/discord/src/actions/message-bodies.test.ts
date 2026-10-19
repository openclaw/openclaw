import { createServer, type Server } from "node:http";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discordMessageActions } from "../channel-actions.js";
import { RequestClient } from "../internal/rest.js";
import * as components from "../send.components.js";
import * as runtime from "../send.js";
import { sendPollDiscord } from "../send.outbound.js";
import { handleDiscordMessageAction } from "./handle-action.js";

vi.mock("../send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.js")>()),
}));
vi.mock("../send.components.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.components.js")>()),
}));

const originalComponents =
  await vi.importActual<typeof import("../send.components.js")>("../send.components.js");

const channelId = "123456789012345678";
const messageId = "223456789012345678";
const guildId = "323456789012345678";
const threadId = "623456789012345678";
const token = "synthetic-message-body-token";
const attachment = { id: "423456789012345678", filename: "example.txt", size: 4 };
const config = (
  overrides: NonNullable<OpenClawConfig["channels"]>["discord"] = {},
): OpenClawConfig => ({
  channels: { discord: { token, groupPolicy: "open", ...overrides } },
});
const cfg = config();
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
  vi.spyOn(runtime, "editMessageDiscord").mockImplementation((channel, id, payload, opts) =>
    original.editMessageDiscord(channel, id, payload, { ...opts, rest }),
  );
  vi.spyOn(runtime, "deleteMessageDiscord").mockImplementation((channel, id, opts) =>
    original.deleteMessageDiscord(channel, id, { ...opts, rest }),
  );
  vi.spyOn(runtime, "fetchChannelInfoDiscord").mockImplementation((channel, opts) =>
    original.fetchChannelInfoDiscord(channel, { ...opts, rest }),
  );
  vi.spyOn(runtime, "fetchGuildInfoDiscord").mockImplementation((guild, opts) =>
    original.fetchGuildInfoDiscord(guild, { ...opts, rest }),
  );
  vi.spyOn(runtime, "sendMessageDiscord").mockImplementation((to, content, opts) =>
    original.sendMessageDiscord(to, content, { ...opts, rest }),
  );
  vi.spyOn(components, "sendDiscordComponentMessage").mockImplementation((to, spec, opts) =>
    originalComponents.sendDiscordComponentMessage(to, spec, { ...opts, rest }),
  );
  vi.spyOn(runtime, "sendStickerDiscord").mockImplementation((to, ids, opts) =>
    original.sendStickerDiscord(to, ids, { ...opts, rest }),
  );
  vi.spyOn(runtime, "createThreadDiscord").mockImplementation((channel, payload, opts) =>
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
const verifySnapshot = { lines: [], plan: [{ step: "Verify", status: "in_progress" }] } as const;

function progressEdit(overrides: Partial<ChannelMessageActionContext> = {}) {
  return discordMessageActions.handleAction?.({
    channel: "discord",
    action: "edit",
    cfg,
    params: { to: `channel:${channelId}`, messageId, message: "Generic fallback" },
    progressSnapshot: verifySnapshot,
    conversationReadOrigin: "direct-operator",
    ...overrides,
  });
}

function expectPost(body: Record<string, unknown>) {
  expect(writes()).toHaveLength(1);
  expect(writes()[0]).toMatchObject({
    method: "POST",
    path: `/v10/channels/${channelId}/messages`,
    body,
  });
  expect(writes()[0]?.body).not.toHaveProperty("content");
}

function expectEdit(target: string, content: unknown, fields: Record<string, unknown> = {}) {
  expect(writes()).toEqual([
    {
      method: "PATCH",
      path: `/v10/channels/${target}/messages/${messageId}`,
      body: { content, ...fields },
    },
  ]);
}

describe("Discord retained progress edits", () => {
  it("edits the same checklist with account-scoped rendering and inert mentions", async () => {
    await progressEdit({
      progressSnapshot: {
        label: "Working",
        statusHeadline: "Waiting @everyone for child verification",
        statusHeadlineFormat: "plain",
        lines: ["Child verifier: checks passed"],
        plan: [
          { step: "Inspect source and configuration", status: "completed" },
          { step: "Verify the child result", status: "in_progress" },
        ],
      },
      cfg: config({
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
      }),
      accountId: "worker",
      params: {
        to: `channel:${threadId}`,
        messageId,
        message: "Generic fallback must not replace the retained card.",
      },
    });

    expectEdit(threadId, expect.stringContaining("Inspect source and configuration"), {
      allowed_mentions: { parse: [] },
    });
    expect(current.content).toContain("Child verifier: checks passed");
    expect(current.content).toContain("Verify the child result");
    expect(current.content).not.toContain("Generic fallback");
    expect(current.attachments).toEqual([attachment]);
  });

  it("bounds a retained edit to one configured Discord message", async () => {
    await progressEdit({
      cfg: config({ textChunkLimit: 100, streaming: { progress: { maxLineChars: 1000 } } }),
      progressSnapshot: { lines: ["Child verifier: " + "result ".repeat(500)] },
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
      const editing = progressEdit({
        conversationReadOrigin: undefined,
        accountId: "default",
        requesterAccountId: "default",
        params: { to: "user:523456789012345678", messageId, message: "Generic fallback" },
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

      expectEdit(channelId, "▸ Verify", { allowed_mentions: { parse: [] } });
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
    const editing = progressEdit({
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

describe("Discord action message bodies", () => {
  const invoke = (
    action: Parameters<typeof handleDiscordMessageAction>[0]["action"],
    params: Record<string, unknown>,
    overrides: Partial<Parameters<typeof handleDiscordMessageAction>[0]> = {},
  ) => handleDiscordMessageAction({ cfg, action, params, ...overrides });
  const send = (content: unknown, extra: Record<string, unknown> = {}) =>
    invoke("send", { to: ` channel:${channelId} `, message: content, ...extra });
  const edit = (content: unknown, cfgOverride = cfg, id: unknown = messageId) =>
    invoke(
      "edit",
      { to: `channel:${channelId}`, messageId: id, message: content },
      {
        cfg: cfgOverride,
        conversationReadOrigin: "direct-operator",
      },
    );
  const createThread = (content?: string) =>
    invoke("thread-create", { channelId, threadName: "example", message: content });

  it.each([
    [0, "a".repeat(2001), 2],
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

  it("clears content while retaining attachments", async () => {
    await edit("");
    expectEdit(channelId, "");
    expect(current).toEqual({ content: "", attachments: [attachment] });
  });

  it("rejects absent edit content without mutation", async () => {
    await expect(edit(undefined)).rejects.toThrow(/required/);
    expect(writes()).toEqual([]);
  });

  it("rejects a blank message ID without mutation", async () => {
    await expect(edit("Changed caption", cfg, "   ")).rejects.toThrow(/required/);
    expect(writes()).toEqual([]);
  });

  it("normalizes identifiers without normalizing the message body", async () => {
    const content = "  Changed caption\n";
    await edit(content, cfg, ` ${messageId} `);
    expectEdit(channelId, content);
    expect(current).toEqual({ content, attachments: [attachment] });
  });

  it("rejects malformed message IDs before a message mutation", async () => {
    await expect(edit("Changed caption", cfg, "..")).rejects.toThrow("Invalid Discord message ID");
    expect(writes()).toEqual([]);
  });

  it("rejects plain sends without content", async () => {
    await expect(send(undefined)).rejects.toThrow(/required/);
    expect(writes()).toEqual([]);
  });

  it("delivers embeds without a text body", async () => {
    const embeds = [{ title: "Release notes", description: "Version available" }];
    await send(undefined, { embeds });
    expectPost({ embeds });
  });

  it("delivers presentation text without a separate message body", async () => {
    const text = "-# Revenue (bar chart)\n- USD: Q1: 12; Q2: 18";
    await send(undefined, {
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
    });
    expectPost({ components: [{ type: 17, components: [{ type: 10, content: text }] }] });
  });

  it("keeps disabled and blocked edit targets from mutating", async () => {
    await expect(
      edit("caption", config({ groupPolicy: undefined, actions: { messages: false } })),
    ).rejects.toThrow(/disabled/);
    await expect(edit("caption", config({ groupPolicy: "disabled" }))).rejects.toThrow(
      /not allowed/,
    );
    expect(writes()).toEqual([]);
  });

  it("deletes the exact message through the same target projection", async () => {
    await invoke(
      "delete",
      { to: `channel:${channelId}`, messageId },
      {
        conversationReadOrigin: "direct-operator",
      },
    );
    expect(writes()).toEqual([
      { method: "DELETE", path: `/v10/channels/${channelId}/messages/${messageId}`, body: {} },
    ]);
  });

  it.each(["send", "thread-reply", "thread-create", "sticker"] as const)(
    "preserves indentation and trailing newline for %s",
    async (action) => {
      const content = "    console.log(1);\n";
      await invoke(action, {
        to: `channel:${channelId}`,
        channelId,
        threadId: channelId,
        threadName: "example",
        message: content,
        stickerId: ["523456789012345678"],
      });
      const messages = writes().filter((request) => request.path.endsWith("/messages"));
      expect(messages).toHaveLength(1);
      expect(messages[0]?.body.content).toBe(content);
    },
  );
});

describe("Discord structured content", () => {
  it.each([
    [undefined, undefined],
    [" \n", undefined],
    ["  Caption\n", "  Caption\n"],
  ])("preserves optional content %j when nonblank", async (content, expected) => {
    await sendPollDiscord(
      `channel:${channelId}`,
      { question: "Lunch?", options: ["Pizza", "Sushi"] },
      { cfg, rest, content },
    );
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body.content).toBe(expected);
    expect(writes()[0]?.body).toHaveProperty("poll");
  });
});
