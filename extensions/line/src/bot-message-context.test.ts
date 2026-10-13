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
const toInboundMediaFactsWithMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  toInboundMediaFactsWithMetadataMock.mockImplementation(actual.toInboundMediaFactsWithMetadata);
  return {
    ...actual,
    toInboundMediaFactsWithMetadata: toInboundMediaFactsWithMetadataMock,
  };
});

// Names are LINE API reads; the context under test only cares what it does with
// the answers, so the two lookups are stubbed and the default answer is "unknown",
// which is what an unreachable or unauthorized LINE account produces.
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

  const buildMessageContext = (
    event: MessageEvent,
    overrides: Partial<Omit<Parameters<typeof buildLineMessageContext>[0], "event">> = {},
  ) =>
    buildLineMessageContext({
      event,
      allMedia: [],
      cfg,
      account,
      commandAuthorized: true,
      ...overrides,
    });

  const buildPostbackContext = (
    event: PostbackEvent,
    overrides: Partial<Omit<Parameters<typeof buildLinePostbackContext>[0], "event">> = {},
  ) =>
    buildLinePostbackContext({
      event,
      cfg,
      account,
      commandAuthorized: true,
      ...overrides,
    });

  const createMessageEvent = (
    source: MessageEvent["source"],
    overrides?: Partial<MessageEvent>,
  ): MessageEvent =>
    ({
      type: "message",
      message: { id: "1", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source,
      mode: "active",
      webhookEventId: "evt-1",
      deliveryContext: { isRedelivery: false },
      ...overrides,
    }) as MessageEvent;

  const createPostbackEvent = (
    source: PostbackEvent["source"],
    overrides?: Partial<PostbackEvent>,
  ): PostbackEvent =>
    ({
      type: "postback",
      postback: { data: "action=select" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source,
      mode: "active",
      webhookEventId: "evt-2",
      deliveryContext: { isRedelivery: false },
      ...overrides,
    }) as PostbackEvent;

  beforeEach(async () => {
    logVerboseMock.mockClear();
    getUserProfileMock.mockClear();
    getLineGroupNameMock.mockClear();
    toInboundMediaFactsWithMetadataMock.mockClear();
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

  it.each([{ kind: "a text message", overrides: {}, chatId: "user-1" }])(
    "remembers the token that quotes $kind it hands the agent",
    async ({ overrides, chatId }) => {
      const event = createMessageEvent({ type: "user", userId: "user-1" }, {
        message: { id: "m-quotable", type: "text", text: "hello", quoteToken: "token-quotable" },
        ...overrides,
      } as Partial<MessageEvent>);

      await buildMessageContext(event);

      expect(
        resolveLineQuoteToken({ cfg, accountId: "default", chatId, messageId: "m-quotable" }),
      ).toBe("token-quotable");
    },
  );

  it("remembers nothing for a message kind LINE attaches no quote token to", async () => {
    const event = createMessageEvent({ type: "user", userId: "user-1" }, {
      message: { id: "m-audio", type: "audio", duration: 1, contentProvider: { type: "line" } },
    } as Partial<MessageEvent>);

    await buildMessageContext(event, {
      allMedia: [{ path: "/tmp/line-audio.m4a", contentType: "audio/mp4" }],
    });

    expect(
      resolveLineQuoteToken({ cfg, accountId: "default", chatId: "user-1", messageId: "m-audio" }),
    ).toBeUndefined();
  });

  it("remembers nothing for a message that never reaches the agent", async () => {
    const event = createMessageEvent({ type: "user", userId: "user-1" }, {
      message: { id: "m-empty", type: "text", text: "", quoteToken: "token-empty" },
    } as Partial<MessageEvent>);

    expect(await buildMessageContext(event)).toBeNull();
    expect(
      resolveLineQuoteToken({ cfg, accountId: "default", chatId: "user-1", messageId: "m-empty" }),
    ).toBeUndefined();
  });

  it("projects a sticker webhook LINE actually sent", async () => {
    // Observed payload from a real LINE sticker message (tokens redacted).
    // Its package id is one the deleted table claimed to know, and LINE's own
    // keywords identify the sticker as a different character than that entry
    // named — so the shipped shape, not a hand-made one, pins this projection.
    const context = await buildMessageContext(
      stickerEvent({
        id: "629316390784598646",
        stickerId: "52002734",
        packageId: "11537",
        stickerResourceType: "ANIMATION",
        keywords: [
          "amaze",
          "Congratulations",
          ":o",
          "!!",
          "brown",
          "Celebrate",
          "Wow",
          "Shock",
          "jolt",
          "astonish",
          "OMG",
          "Yay",
          "bewildered",
          "ohyeah",
          "Surprised",
        ],
      }),
    );

    expect(context?.ctxPayload.RawBody).toBe("[Sent a sticker: amaze, Congratulations, :o]");
  });

  it.each([["   ", "[Sent a sticker:    ]"]])(
    "preserves sender-authored sticker whitespace",
    async (text, expected) => {
      const context = await buildMessageContext(stickerEvent({ text, keywords: ["fallback"] }));

      expect(context?.ctxPayload.RawBody).toBe(expected);
    },
  );

  it("still reports a sticker that carries neither keywords nor text", async () => {
    const context = await buildMessageContext(stickerEvent({}));

    expect(context?.ctxPayload.RawBody).toBe("[Sent a sticker]");
  });

  it("keeps inbound log previews UTF-16 well-formed at the limit", async () => {
    const timestamp = 1_700_000_000_000;
    await buildMessageContext(
      createMessageEvent({ type: "user", userId: "user-1" }, {
        timestamp,
        message: { id: "baseline", type: "text", text: "BODY_MARKER" },
      } as Partial<MessageEvent>),
      {
        cfg,
      },
    );
    // Identity lookups log their own misses, so select the preview line by shape
    // rather than by call order.
    const baselineLog =
      logVerboseMock.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('preview="')) ?? "";
    const baselinePreview = baselineLog.match(/preview="(.*)"$/)?.[1] ?? "";
    const markerIndex = baselinePreview.indexOf("BODY_MARKER");
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const rawBody = `${"x".repeat(199 - markerIndex)}🚀tail`;
    logVerboseMock.mockClear();

    await buildMessageContext(
      createMessageEvent({ type: "user", userId: "user-1" }, {
        timestamp,
        message: { id: "1", type: "text", text: rawBody },
      } as Partial<MessageEvent>),
      {
        cfg,
      },
    );
    const expectedPreview = `${baselinePreview.slice(0, markerIndex)}${"x".repeat(199 - markerIndex)}`;
    const formattedBodyLength = markerIndex + rawBody.length;

    expect(logVerboseMock).toHaveBeenCalledWith(
      `line inbound: from=line:user-1 len=${formattedBodyLength} preview="${expectedPreview}"`,
    );
  });

  it("keeps failed media-only command text empty and preserves its native media fact", async () => {
    const event = createMessageEvent({ type: "user", userId: "user-image" }, {
      message: {
        id: "image-1",
        type: "image",
        contentProvider: { type: "line" },
      },
    } as Partial<MessageEvent>);

    const context = await buildMessageContext(event, {
      mediaUnavailable: true,
      commandAuthorized: false,
    });

    expect(context?.ctxPayload.RawBody).toBe("");
    expect(context?.ctxPayload.CommandBody).toBe("");
    expect(context?.ctxPayload.CommandAuthorized).toBe(false);
    expect(context?.ctxPayload.BodyForAgent).toBe("[line attachment unavailable]");
    expect(context?.ctxPayload.media?.[0]).toMatchObject({
      path: undefined,
      kind: "image",
    });
  });

  it("tells the agent how much of a multi-image send never arrived", async () => {
    const event = createMessageEvent({ type: "user", userId: "user-image" }, {
      message: {
        id: "image-1",
        type: "image",
        contentProvider: { type: "line" },
      },
    } as Partial<MessageEvent>);

    const context = await buildMessageContext(event, {
      allMedia: [{ path: "/tmp/one.png", contentType: "image/png" }],
      missingParts: 2,
    });

    // Without this the turn reads as the whole send and the agent answers
    // confidently about images the sender can see are missing.
    expect(context?.ctxPayload.BodyForAgent).toBe(
      "[line: 2 more images in this send were not delivered]",
    );
  });

  it("counts a single missing image in the singular", async () => {
    const event = createMessageEvent({ type: "user", userId: "user-image" }, {
      message: {
        id: "image-1",
        type: "image",
        contentProvider: { type: "line" },
      },
    } as Partial<MessageEvent>);

    const context = await buildMessageContext(event, {
      allMedia: [{ path: "/tmp/one.png", contentType: "image/png" }],
      missingParts: 1,
    });

    // A media-only send has no other text, so this sentence is the whole body the
    // model reads; it has to be a sentence.
    expect(context?.ctxPayload.BodyForAgent).toBe(
      "[line: 1 more image in this send was not delivered]",
    );
  });

  it("resolves prefixed-only group config through the inbound message context", async () => {
    const event = createMessageEvent({ type: "group", groupId: "group-1", userId: "user-1" });

    const context = await buildMessageContext(event, {
      cfg: {
        ...cfg,
        agents: { entries: { main: {}, "line-group-agent": {} } },
        bindings: [
          {
            agentId: "line-group-agent",
            match: { channel: "line", peer: { kind: "group", id: "group-1" } },
          },
        ],
      },
      account: {
        ...account,
        config: {
          groups: {
            "group:group-1": {
              systemPrompt: "Use the prefixed group config",
              skills: ["triage"],
            },
          },
        },
      },
    });

    expect(context?.ctxPayload.GroupSystemPrompt).toBe("Use the prefixed group config");
    expect(context?.skillFilter).toEqual(["triage"]);
    expect(context?.route.agentId).toBe("line-group-agent");
    expect(context?.route.matchedBy).toBe("binding.peer");
  });

  it("resolves prefixed-only room config through the inbound message context", async () => {
    const event = createMessageEvent({ type: "room", roomId: "room-1", userId: "user-1" });

    const context = await buildMessageContext(event, {
      cfg: {
        ...cfg,
        agents: { entries: { main: {}, "line-room-agent": {} } },
        bindings: [
          {
            agentId: "line-room-agent",
            match: { channel: "line", peer: { kind: "group", id: "room-1" } },
          },
        ],
      },
      account: {
        ...account,
        config: {
          groups: {
            "room:room-1": {
              systemPrompt: "Use the prefixed room config",
              skills: [],
            },
          },
        },
      },
    });

    expect(context?.ctxPayload.GroupSystemPrompt).toBe("Use the prefixed room config");
    expect(context?.skillFilter).toEqual([]);
    expect(context?.route.agentId).toBe("line-room-agent");
    expect(context?.route.matchedBy).toBe("binding.peer");
  });

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
      const event = createPostbackEvent({ type: "user", userId: "user-pb" }, { postback });

      const context = await buildPostbackContext(event);

      expect(context?.ctxPayload.BodyForAgent).toBe(expected);
      // The callback token stays verbatim so command gating keeps matching on it.
      expect(context?.ctxPayload.RawBody).toBe(postback.data);
      expect(context?.ctxPayload.CommandBody).toBe(postback.data);
      expect(context?.ctxPayload.CommandAuthorized).toBe(true);
    },
  );

  it("keeps per-channel-peer direct-message last-route writes on the isolated session", async () => {
    const event = createMessageEvent({ type: "user", userId: "user-1" });
    const directCfg: OpenClawConfig = {
      session: { store: storePath, dmScope: "per-channel-peer" },
    };

    const context = await buildMessageContext(event, {
      cfg: directCfg,
      account: {
        ...account,
        config: { allowFrom: ["user-1"] },
      },
    });

    expect(context?.route.sessionKey).toBe("agent:main:line:direct:user-1");
    const updateLastRoute = context?.turn.record.updateLastRoute;
    expect(updateLastRoute?.sessionKey).toBe(context?.route.sessionKey);
    expect(updateLastRoute?.sessionKey).not.toBe("agent:main:main");
    expect(updateLastRoute?.channel).toBe("line");
    expect(updateLastRoute?.to).toBe("user-1");
    expect(updateLastRoute?.mainDmOwnerPin).toBeUndefined();
  });

  it("normalizes canonical LINE targets through the plugin bindings surface", () => {
    const compiled = lineBindingsAdapter.compileConfiguredBinding({
      conversationId: "line:U1234567890abcdef1234567890abcdef",
    });

    expect(compiled).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
    });
    expect(
      lineBindingsAdapter.resolveCommandConversation({
        originatingTo: "line:U1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
    });
    expect(
      lineBindingsAdapter.matchInboundConversation({
        compiledBinding: compiled!,
        conversationId: "U1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
      matchPriority: 2,
    });
  });

  it("routes LINE conversations through active ACP session bindings", async () => {
    const userId = "U1234567890abcdef1234567890abcdef";
    const bindingService = getSessionBindingService();
    await bindingService.bind({
      targetSessionKey: "agent:codex:acp:binding:line:default:test123",
      targetKind: "session",
      conversation: {
        channel: "line",
        accountId: "default",
        conversationId: userId,
      },
      placement: "current",
      metadata: {
        agentId: "codex",
      },
    });
    const touchAsync = vi.spyOn(bindingService, "touchAsync").mockImplementation(async () => {});

    try {
      const event = createMessageEvent({ type: "user", userId });
      const context = await buildMessageContext(event);

      expect(context?.route.agentId).toBe("codex");
      expect(context?.route.sessionKey).toBe("agent:codex:acp:binding:line:default:test123");
      expect(context?.route.matchedBy).toBe("binding.channel");
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

    expect(context?.ctxPayload.SenderName).toBe("Sora");
    expect(context?.ctxPayload.GroupSubject).toBe("Release Squad");
    expect(context?.ctxPayload.ConversationLabel).toBe("Release Squad");
    // The envelope the agent reads names the speaker rather than their raw id.
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
      mention: { mentionees: [{ type: "user" as const, index: 0, length: 10, isSelf: true }] },
    },
  ])(
    "projects LINE emoji metadata without losing text: $text",
    async ({ text, spans, expected, mention }) => {
      const context = await buildMessageContext(
        createMessageEvent(
          { type: "user", userId: "user-1" },
          {
            message: {
              id: "emoji-message",
              type: "text",
              text,
              quoteToken: "quote-token",
              emojis: spans.map(([index, length]) => ({
                index,
                length,
                productId: "emoji-set",
                emojiId: "1",
              })),
              mention,
            },
          },
        ),
      );

      expect(context?.ctxPayload.BodyForAgent).toBe(expected);
      expect(context?.ctxPayload.RawBody).toBe(expected);
      expect(context?.ctxPayload.CommandBody).toBe(mention ? "()" : text);
      expect(context?.ctxPayload.BodyForCommands).toBe(context?.ctxPayload.CommandBody);
    },
  );
});
