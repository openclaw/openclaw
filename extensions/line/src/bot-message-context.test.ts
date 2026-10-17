import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionBindingService,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineBindingsAdapter } from "./bindings.js";
import { buildLineMessageContext, buildLinePostbackContext } from "./bot-message-context.js";
import { resolveLineQuoteToken } from "./quote-tokens.js";
import type { ResolvedLineAccount } from "./types.js";

const logVerboseMock = vi.hoisted(() => vi.fn());
const getUserProfileMock = vi.hoisted(() =>
  vi.fn(async () => null as { displayName: string } | null),
);
const getLineGroupNameMock = vi.hoisted(() => vi.fn(async () => undefined as string | undefined));
vi.mock("./send.js", () => ({
  getUserProfile: getUserProfileMock,
  getLineGroupName: getLineGroupNameMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: logVerboseMock,
    shouldLogVerbose: () => true,
  };
});

type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;

const lineBindingsPlugin = {
  id: "line",
  bindings: lineBindingsAdapter,
  conversationBindings: {
    defaultTopLevelPlacement: "current",
    supportsCurrentConversationBinding: true,
  },
};

describe("buildLineMessageContext", () => {
  let tmpDir: string;
  let storePath: string;
  let cfg: OpenClawConfig;
  const account: ResolvedLineAccount = {
    accountId: "default",
    enabled: true,
    channelAccessToken: "token",
    channelSecret: "secret",
    tokenSource: "config",
    config: {},
  };
  const contextDefaults = () => ({ cfg, account, commandAuthorized: true });

  const buildMessageContext = (
    event: MessageEvent,
    overrides: Partial<Omit<Parameters<typeof buildLineMessageContext>[0], "event">> = {},
  ) =>
    buildLineMessageContext({
      event,
      allMedia: [],
      ...contextDefaults(),
      ...overrides,
    });

  const postbackContext = (postback: PostbackEvent["postback"]) =>
    buildLinePostbackContext({
      event: createPostbackEvent(postback),
      ...contextDefaults(),
    });

  const createMessageEvent = (
    source: MessageEvent["source"],
    overrides?: Partial<MessageEvent>,
  ): MessageEvent =>
    ({
      ...eventDefaults,
      type: "message",
      message: { id: "1", type: "text", text: "hello" },
      source,
      ...overrides,
    }) as MessageEvent;

  const createPostbackEvent = (postback: PostbackEvent["postback"]): PostbackEvent => ({
    ...eventDefaults,
    type: "postback",
    postback,
    source: userSource,
  });
  const eventDefaults = {
    replyToken: "reply-token",
    timestamp: 1_800_000_000_000,
    mode: "active",
    webhookEventId: "evt-1",
    deliveryContext: { isRedelivery: false },
  } as const;

  beforeEach(async () => {
    logVerboseMock.mockClear();
    getUserProfileMock.mockClear();
    getLineGroupNameMock.mockClear();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: lineBindingsPlugin.id,
          plugin: lineBindingsPlugin,
          source: "test",
        },
      ]),
    );
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-context-"));
    storePath = path.join(tmpDir, "sessions.json");
    cfg = { session: { store: storePath } };
  });

  afterEach(async () => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    await fs.rm(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });

  const stickerEvent = (sticker: Partial<Record<string, unknown>>) =>
    createMessageEvent({ type: "user", userId: "user-1" }, {
      message: {
        id: "m-sticker",
        type: "sticker",
        packageId: "6136",
        stickerId: "10979904",
        stickerResourceType: "STATIC",
        quoteToken: "quote-token",
        ...sticker,
      },
    } as Partial<MessageEvent>);

  const userSource = { type: "user", userId: "user-1" } as const;
  const messageContext = (
    message: MessageEvent["message"],
    overrides: Parameters<typeof buildMessageContext>[1] = {},
  ) => buildMessageContext(createMessageEvent(userSource, { message }), overrides);
  const imageEvent = () =>
    createMessageEvent(
      { type: "user", userId: "user-image" },
      {
        message: { id: "image-1", type: "image", contentProvider: { type: "line" } },
      },
    );

  const quoteToken = (messageId: string) =>
    resolveLineQuoteToken({ cfg, accountId: "default", chatId: "user-1", messageId });

  it("remembers the token that quotes a text message it hands the agent", async () => {
    await messageContext({
      id: "m-quotable",
      type: "text",
      text: "hello",
      quoteToken: "token-quotable",
    });
    expect(quoteToken("m-quotable")).toBe("token-quotable");
  });

  it("remembers nothing for a message kind LINE attaches no quote token to", async () => {
    await messageContext(
      { id: "m-audio", type: "audio", duration: 1, contentProvider: { type: "line" } },
      {
        allMedia: [{ path: "/tmp/line-audio.m4a", contentType: "audio/mp4" }],
      },
    );

    expect(quoteToken("m-audio")).toBeUndefined();
  });

  it("remembers nothing for a message that never reaches the agent", async () => {
    expect(
      await messageContext({ id: "m-empty", type: "text", text: "", quoteToken: "token-empty" }),
    ).toBeNull();
    expect(quoteToken("m-empty")).toBeUndefined();
  });

  it.each([
    [
      "LINE keywords",
      {
        keywords: ["amaze", "Congratulations", ":o", "!!"],
      },
      "[Sent a sticker: amaze, Congratulations, :o]",
    ],
    ["sender whitespace", { text: "   ", keywords: ["fallback"] }, "[Sent a sticker:    ]"],
    ["no description", {}, "[Sent a sticker]"],
  ] as const)("projects stickers with %s", async (_name, sticker, expected) => {
    const context = await buildMessageContext(stickerEvent(sticker));
    expect(context?.ctxPayload.RawBody).toBe(expected);
  });

  it.each(["message", "postback"])("preserves %s content without logging it", async (kind) => {
    const rawBody = "private-line-message\n🚀";
    const context =
      kind === "message"
        ? await messageContext({ id: "1", type: "text", text: rawBody })
        : await postbackContext({ data: rawBody });

    expect(context?.ctxPayload).toMatchObject({ RawBody: rawBody, BodyForAgent: rawBody });
    expect(logVerboseMock.mock.calls.flat().join("\n")).not.toContain("private-line-message");
  });

  it("keeps failed media-only command text empty and preserves its native media fact", async () => {
    const context = await buildMessageContext(imageEvent(), {
      mediaUnavailable: true,
      commandAuthorized: false,
    });

    expect(context?.ctxPayload).toMatchObject({
      RawBody: "",
      CommandBody: "",
      CommandAuthorized: false,
      BodyForAgent: "[line attachment unavailable]",
      media: [expect.objectContaining({ path: undefined, kind: "image" })],
    });
  });

  it.each([
    [2, "2 more images in this send were"],
    [1, "1 more image in this send was"],
  ] as const)("reports %i missing images with correct grammar", async (missingParts, notice) => {
    const context = await buildMessageContext(imageEvent(), {
      allMedia: [{ path: "/tmp/one.png", contentType: "image/png" }],
      missingParts,
    });

    expect(context?.ctxPayload.BodyForAgent).toBe(`[line: ${notice} not delivered]`);
  });

  it.each([
    { kind: "group", id: "group-1", skills: ["triage"] },
    { kind: "room", id: "room-1", skills: [] },
  ] as const)(
    "resolves prefixed-only $kind config through the inbound message context",
    async ({ kind, id, skills }) => {
      const agentId = "line-" + kind + "-agent";
      const systemPrompt = "Use the prefixed " + kind + " config";
      const source: MessageEvent["source"] =
        kind === "group"
          ? { type: "group", groupId: id, userId: "user-1" }
          : { type: "room", roomId: id, userId: "user-1" };
      const context = await buildMessageContext(createMessageEvent(source), {
        cfg: {
          ...cfg,
          agents: { entries: { main: {}, [agentId]: {} } },
          bindings: [{ agentId, match: { channel: "line", peer: { kind: "group", id } } }],
        },
        account: {
          ...account,
          config: { groups: { [kind + ":" + id]: { systemPrompt, skills: [...skills] } } },
        },
      });
      expect(context).toMatchObject({
        ctxPayload: { GroupSystemPrompt: systemPrompt },
        skillFilter: skills,
        route: { agentId, matchedBy: "binding.peer" },
      });
    },
  );
  const postbackSelectionCases: {
    name: string;
    postback: PostbackEvent["postback"];
    expected: string;
  }[] = [
    {
      name: "rich menu switch",
      postback: {
        data: "menu",
        params: { status: "SUCCESS", newRichMenuAliasId: "richmenu-alias-b" },
      },
      expected: "menu newRichMenuAliasId=richmenu-alias-b status=SUCCESS",
    },
    {
      name: "device control",
      postback: { data: "line.action=volume_up&line.device=Living%20Room" },
      expected: "line action volume_up device Living Room",
    },
  ];

  it.each(postbackSelectionCases)(
    "gives the agent what the user picked in a $name postback",
    async ({ postback, expected }) => {
      const context = await postbackContext(postback);

      expect(context?.ctxPayload).toMatchObject({
        BodyForAgent: expected,
        RawBody: postback.data,
        CommandBody: postback.data,
        CommandAuthorized: true,
      });
    },
  );

  it("keeps per-channel-peer direct-message last-route writes on the isolated session", async () => {
    const context = await buildMessageContext(createMessageEvent(userSource), {
      cfg: { session: { store: storePath, dmScope: "per-channel-peer" } },
      account: { ...account, config: { allowFrom: ["user-1"] } },
    });
    const sessionKey = "agent:main:line:direct:user-1";
    expect(context?.route).toMatchObject({ sessionKey });
    expect(context?.turn.record.updateLastRoute).toMatchObject({
      sessionKey,
      channel: "line",
      to: "user-1",
      mainDmOwnerPin: undefined,
    });
  });

  it("normalizes canonical LINE targets through the plugin bindings surface", () => {
    const conversationId = "U1234567890abcdef1234567890abcdef";
    const compiled = lineBindingsAdapter.compileConfiguredBinding({
      conversationId: `line:${conversationId}`,
    });

    expect(compiled).toEqual({ conversationId });
    expect(
      lineBindingsAdapter.resolveCommandConversation({
        originatingTo: `line:${conversationId}`,
      }),
    ).toEqual({ conversationId });
    expect(
      lineBindingsAdapter.matchInboundConversation({
        compiledBinding: compiled!,
        conversationId,
      }),
    ).toEqual({
      conversationId,
      matchPriority: 2,
    });
  });

  it("routes LINE conversations through active ACP session bindings", async () => {
    const userId = "U1234567890abcdef1234567890abcdef";
    const sessionKey = "agent:codex:acp:binding:line:default:test123";
    const bindingService = getSessionBindingService();
    await bindingService.bind({
      targetSessionKey: sessionKey,
      targetKind: "session",
      conversation: {
        channel: "line",
        accountId: "default",
        conversationId: userId,
      },
      placement: "current",
      metadata: { agentId: "codex" },
    });
    const touchAsync = vi.spyOn(bindingService, "touchAsync").mockImplementation(async () => {});

    try {
      const event = createMessageEvent({ type: "user", userId });
      const context = await buildMessageContext(event);

      expect(context?.route).toMatchObject({
        agentId: "codex",
        sessionKey,
        matchedBy: "binding.channel",
      });
      if (!context) {
        throw new Error("expected a bound LINE message context");
      }
      const routeMetadataKeys = Object.getOwnPropertySymbols(context.route);
      expect(routeMetadataKeys).not.toHaveLength(0);
      for (const key of routeMetadataKeys) {
        expect(Reflect.get(context.ctxPayload, key)).toBe(Reflect.get(context.route, key));
      }
      expect(touchAsync).toHaveBeenCalledOnce();
    } finally {
      touchAsync.mockRestore();
    }
  });

  it("gives the agent the sender's and the group's name instead of their ids", async () => {
    getUserProfileMock.mockResolvedValueOnce({ displayName: "Sora" });
    getLineGroupNameMock.mockResolvedValueOnce("Release Squad");

    const event = createMessageEvent({
      type: "group",
      groupId: "C5aeb18d690759492f1a8c391c37549a0",
      userId: "U47f0bbc534dc503c4e4cadc86e619b63",
    });
    const context = await buildMessageContext(event);

    expect(context?.ctxPayload).toMatchObject({
      SenderName: "Sora",
      GroupSubject: "Release Squad",
      ConversationLabel: "Release Squad",
    });
    expect(context?.ctxPayload.Body).toContain("Sora");
    expect(context?.ctxPayload.Body).not.toContain("user:U47f0bbc534dc503c4e4cadc86e619b63");
  });

  it.each<{
    text: string;
    spans: [number, number][];
    expected: string;
    mention?: webhook.TextMessageContent["mention"];
  }>([
    {
      text: "😂() (hello)",
      spans: [
        [2, 2],
        [5, 7],
      ],
      expected: "😂[emoji] (hello)",
    },
    {
      text: "@openclaw3 ()",
      spans: [[11, 2]],
      expected: "@openclaw3 [emoji]",
      mention: { mentionees: [{ type: "user", index: 0, length: 10, isSelf: true }] },
    },
  ])(
    "projects LINE emoji metadata without losing text: $text",
    async ({ text, spans, expected, mention }) => {
      const context = await messageContext({
        id: "emoji-message",
        type: "text",
        text,
        quoteToken: "quote-token",
        mention,
        emojis: spans.map(([index, length]) => ({
          index,
          length,
          productId: "emoji-set",
          emojiId: "1",
        })),
      });
      expect(context?.ctxPayload).toMatchObject({
        BodyForAgent: expected,
        RawBody: expected,
        CommandBody: mention ? "()" : text,
        BodyForCommands: mention ? "()" : text,
      });
    },
  );
});
