import { createServer, type Server } from "node:http";
import { text as readText } from "node:stream/consumers";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { DiscordConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discordMessageActions } from "../channel-actions.js";
import { sendPollDiscord } from "../send.outbound.js";
import { handleDiscordMessageAction } from "./handle-action.js";

const channelId = "123456789012345678";
const messageId = "223456789012345678";
const guildId = "323456789012345678";
const threadId = "623456789012345678";
const token = "synthetic-message-body-token";
const attachment = { id: "423456789012345678", filename: "example.txt", size: 4 };
const config = (overrides: DiscordConfig = {}): OpenClawConfig => ({
  channels: { discord: { token, groupPolicy: "open", ...overrides } },
});
const cfg = config();
const originalFetch = globalThis.fetch;
let server: Server;
let baseUrl: string;
let requests: { method: string; path: string; body: Record<string, unknown> }[];
let current: { content: string; attachments: (typeof attachment)[] };
let unexpectedUrls: string[];
let parentChannelType: number;
let threadMessageIds: string[];
let lookupStarted: (() => void) | undefined;
let lookupResume: Promise<void> | undefined;

beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      try {
        expect(request.headers.authorization).toBe(`Bot ${token}`);
        const body = JSON.parse((await readText(request)) || "{}") as Record<string, unknown>;
        const method = request.method ?? "";
        const path = request.url ?? "";
        requests.push({ method, path, body });
        if (method === "GET" && path === `/v10/channels/${channelId}`) {
          lookupStarted?.();
          await lookupResume;
        }
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
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP fixture did not bind a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== baseUrl) {
      unexpectedUrls.push(url.href);
      throw new Error("HTTP fixture refused a request outside its loopback server");
    }
    return originalFetch(input, init);
  });
});

beforeEach(() => {
  vi.stubEnv("DISCORD_API_URL", `${baseUrl}/v10`);
  lookupStarted = lookupResume = undefined;
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
  server?.closeAllConnections();
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

const writes = () => requests.filter((request) => request.method !== "GET");
const messagePath = (channel = channelId) => `/v10/channels/${channel}/messages`;
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
  expect(writes()).toMatchObject([{ method: "POST", path: messagePath(), body }]);
  expect(writes()[0]?.body).not.toHaveProperty("content");
}

function expectEdit(target: string, content: unknown, fields: Record<string, unknown> = {}) {
  expect(writes()).toEqual([
    {
      method: "PATCH",
      path: `${messagePath(target)}/${messageId}`,
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
      params: { to: `channel:${threadId}`, messageId, message: "Generic fallback" },
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

    expectEdit(channelId, expect.stringContaining("Child verifier:"), {
      allowed_mentions: { parse: [] },
    });
    expect(current.content.length).toBeLessThanOrEqual(100);
  });

  it.each([true, false])("requires a matching DM target: %s", async (matching) => {
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
  });

  it("fences a retained edit when its owner retires during target policy lookup", async () => {
    const started = createDeferred<void>();
    const resume = createDeferred<void>();
    lookupStarted = started.resolve;
    lookupResume = resume.promise;
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
  const mutate = (action: "edit" | "delete", params: Record<string, unknown>, settings = cfg) =>
    invoke(action, params, { cfg: settings, conversationReadOrigin: "direct-operator" });
  const send = (content: unknown, extra: Record<string, unknown> = {}) =>
    invoke("send", { to: ` channel:${channelId} `, message: content, ...extra });
  const edit = (content: unknown, cfgOverride = cfg, id: unknown = messageId) =>
    mutate("edit", { to: `channel:${channelId}`, messageId: id, message: content }, cfgOverride);
  const createThread = (content?: string) =>
    invoke("thread-create", { channelId, threadName: "example", message: content });

  it.each([
    [0, "a".repeat(2001), 2],
    [15, "a".repeat(2001), 2],
    [16, undefined, 1],
  ] as const)("parent %i initial delivery (case %#)", async (type, content, chunkCount) => {
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
  });

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

  it("normalizes identifiers without normalizing the message body", async () => {
    const content = "  Changed caption\n";
    await edit(content, cfg, ` ${messageId} `);
    expectEdit(channelId, content);
    expect(current).toEqual({ content, attachments: [attachment] });
  });

  it.each([
    ["absent edit content", () => edit(undefined), /required/],
    ["blank message ID", () => edit("caption", cfg, "   "), /required/],
    ["malformed message ID", () => edit("caption", cfg, ".."), "Invalid Discord message ID"],
    ["plain send without content", () => send(undefined), /required/],
  ] as const)("rejects %s without mutation", async (_name, action, error) => {
    await expect(action()).rejects.toThrow(error);
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

  it.each([
    [config({ groupPolicy: undefined, actions: { messages: false } }), /disabled/],
    [config({ groupPolicy: "disabled" }), /not allowed/],
  ] as const)("blocks edit mutations: %s", async (settings, error) => {
    await expect(edit("caption", settings)).rejects.toThrow(error);
    expect(writes()).toEqual([]);
  });

  it("deletes the exact message through the same target projection", async () => {
    await mutate("delete", { to: `channel:${channelId}`, messageId });
    expect(writes()).toEqual([
      { method: "DELETE", path: `${messagePath()}/${messageId}`, body: {} },
    ]);
  });

  it.each(["send", "thread-reply", "thread-create", "sticker"] as const)(
    "preserves whitespace for %s",
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
  it.each([
    [undefined, undefined],
    [" \n", undefined],
    ["  Caption\n", "  Caption\n"],
  ])("preserves optional content %j when nonblank", async (content, expected) => {
    await sendPollDiscord(
      `channel:${channelId}`,
      { question: "Lunch?", options: ["Pizza", "Sushi"] },
      { cfg, content },
    );
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body.content).toBe(expected);
    expect(writes()[0]?.body).toHaveProperty("poll");
  });
});
