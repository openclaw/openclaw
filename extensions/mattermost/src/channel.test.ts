import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, ReplyPayload } from "../runtime-api.js";

const { sendMessageMattermostMock, mockFetchGuard } = vi.hoisted(() => ({
  sendMessageMattermostMock: vi.fn<typeof import("./mattermost/send.js").sendMessageMattermost>(),
  mockFetchGuard: vi.fn(async (p: { url: string; init?: RequestInit }) => {
    const response = await globalThis.fetch(p.url, p.init);
    return { response, release: async () => {}, finalUrl: p.url };
  }),
}));

vi.mock("./mattermost/send.js", () => ({
  sendMessageMattermost: sendMessageMattermostMock,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  )),
  fetchWithSsrFGuard: mockFetchGuard,
}));

import { mattermostPlugin } from "./channel.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
  withMockedGlobalFetch,
} from "./mattermost/reactions.test-helpers.js";
import type { MattermostConfig } from "./types.js";

const actions = mattermostPlugin.actions!;
const outbound = mattermostPlugin.outbound!;
const threading = mattermostPlugin.threading!;
type ActionContext = Parameters<NonNullable<typeof actions.handleAction>>[0];
type Presentation = NonNullable<ReplyPayload["presentation"]>;
type Button = Extract<Presentation["blocks"][number], { type: "buttons" }>["buttons"][number];

const mediaLocalRoots = Object.freeze(["/tmp/workspace"]);
const workspaceDir = "/tmp/workspace";
const makeMediaReader = () => vi.fn(async () => Buffer.from("image"));
const mediaAccess = (readFile: ReturnType<typeof makeMediaReader>) => ({
  localRoots: mediaLocalRoots,
  workspaceDir,
  readFile,
});
const outboundContext = (text = "report") => ({ cfg: config(), to: "channel:CHAN1", text });

const config = (mattermost: MattermostConfig = {}): OpenClawConfig => ({
  channels: { mattermost: { ...createMattermostTestConfig().channels?.mattermost, ...mattermost } },
});

function action(overrides: Partial<ActionContext>): ActionContext {
  return { channel: "mattermost", action: "send", params: {}, cfg: config(), ...overrides };
}

function runAction(overrides: Partial<ActionContext>, fetchImpl: typeof fetch) {
  return withMockedGlobalFetch(fetchImpl, () => actions.handleAction!(action(overrides)));
}

function react(
  params: ActionContext["params"],
  fixture: Partial<Parameters<typeof createMattermostReactionFetchMock>[0]>,
  overrides: Partial<ActionContext> = {},
) {
  return runAction(
    {
      action: "react",
      accountId: "default",
      conversationReadOrigin: "delegated",
      params: { messageId: "POST1", ...params },
      ...overrides,
    },
    createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      emojiName: "thumbsup",
      ...fixture,
    }),
  );
}

async function expectBlockedAction(overrides: Partial<ActionContext>, error: string) {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(runAction(overrides, fetchImpl)).rejects.toThrow(error);
  expect(fetchImpl).not.toHaveBeenCalled();
}

function sendResult(messageId = "post-1", content = "report", kind: "text" | "card" = "text") {
  return {
    messageId,
    channelId: "channel-1",
    content,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind, index: 0 }],
      sentAt: 1,
    },
  };
}

async function sendPrepared(overrides: Partial<ActionContext>) {
  const ctx = action(overrides);
  const to = "channel:CHAN1";
  const text = typeof ctx.params.message === "string" ? ctx.params.message : "report";
  const payload = await actions.prepareSendPayload!({ ctx, to, payload: { text } });
  expect(payload).not.toBeNull();
  return outbound.sendPayload!({
    cfg: ctx.cfg,
    to,
    text,
    payload: payload!,
    accountId: ctx.accountId ?? undefined,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
  });
}

async function render(buttons: Button[], texts: string[] = [], extras: ReplyPayload = {}) {
  const blocks: Presentation["blocks"] = [
    ...texts.map((text) => ({ type: "text" as const, text })),
    { type: "buttons", buttons },
  ];
  const payload = { ...extras, presentation: { blocks } };
  return outbound.renderPresentation!({
    payload,
    presentation: payload.presentation,
    ctx: { ...outboundContext(""), payload },
  });
}

function expectSend(text = "report") {
  expect(sendMessageMattermostMock).toHaveBeenCalledExactlyOnceWith(
    "channel:CHAN1",
    text,
    expect.anything(),
  );
  return sendMessageMattermostMock.mock.calls[0]![2];
}

beforeEach(() => {
  sendMessageMattermostMock.mockReset();
  sendMessageMattermostMock.mockResolvedValue(sendResult());
});

describe("Mattermost configuration and threading", () => {
  it("requires an explicit user namespace for direct targets", () => {
    const infer = mattermostPlugin.messaging!.inferTargetChatType!;
    expect(infer({ to: "user:owner" })).toBe("direct");
    expect(infer({ to: "channel:operators" })).toBe("channel");
    expect(infer({ to: "ambiguous" })).toBeUndefined();
  });

  it("keeps sibling resolution stable across named-account additions and edits", () => {
    const beta = { baseUrl: "https://beta.example.com", chatmode: "onmessage" as const };
    const before: OpenClawConfig = {
      channels: { mattermost: { replyToMode: "first", accounts: { beta } } },
    };
    const expected = mattermostPlugin.config.resolveAccount(before, "beta");
    for (const baseUrl of ["https://alpha.example.com", "https://alpha-new.example.com"]) {
      const after = {
        channels: {
          mattermost: { replyToMode: "first" as const, accounts: { beta, alpha: { baseUrl } } },
        },
      };
      expect(mattermostPlugin.config.resolveAccount(after, "beta")).toEqual(expected);
    }
  });

  it("normalizes pairing allowlist entries", () => {
    const normalize = mattermostPlugin.pairing!.normalizeAllowEntry!;
    expect(normalize("  @Alice  ")).toBe("alice");
    expect(normalize("user:USER123")).toBe("user123");
    expect(normalize("  mattermost:USER123  ")).toBe("user123");
  });

  it("formats allowFrom entries", () => {
    expect(
      mattermostPlugin.config.formatAllowFrom!({
        cfg: {},
        allowFrom: [" @Alice ", " user:USER123 ", " mattermost:BOT999 "],
      }),
    ).toEqual(["@alice", "user123", "bot999"]);
  });

  it.each([
    ["existing thread", "child-1", "root-1", undefined, "all", { value: false }],
    ["new thread", "post-1", "post-1", "first", "first", undefined],
  ] as const)(
    "builds tool context for %s",
    (_name, messageId, rootId, replyToMode, expectedMode, hasRepliedRef) => {
      const result = threading.buildToolContext!({
        cfg: config({ replyToMode }),
        accountId: "default",
        hasRepliedRef,
        context: {
          To: "channel:C1",
          ChatType: "channel",
          CurrentMessageId: messageId,
          MessageThreadId: rootId,
        },
      });
      expect(result).toEqual({
        currentChannelId: "channel:C1",
        currentThreadTs: rootId,
        currentMessageId: messageId,
        replyToMode: expectedMode,
        hasRepliedRef,
        sameChannelThreadRequired: true,
      });
    },
  );

  it("matches bare channel ids against the active target", () => {
    const match = threading.matchesToolContextTarget!;
    const target = "tqfek9psh7fw8mpa5berwyytqw";
    expect(match({ target, toolContext: { currentChannelId: "channel:" + target } })).toBe(true);
    expect(
      match({ target, toolContext: { currentChannelId: "channel:kqfek9psh7fw8mpa5berwyytqw" } }),
    ).toBe(false);
  });

  it.each([
    ["explicit-root", "child-post", "root-post", true, undefined, undefined, "root-post"],
    ["numeric-root", undefined, 42, undefined, undefined, undefined, "42"],
    ["existing-thread", "child-post", "root-post", undefined, "channel", "all", "root-post"],
    ["explicit-other", "other-root", "ambient-root", true, "channel", "all", "other-root"],
    ["direct-all", "dm-post", undefined, undefined, "direct", "all", "dm-post"],
    ["direct-off", "dm-post", undefined, undefined, "direct", "off", null],
  ] as const)(
    "resolves %s transport routing",
    (_name, replyToId, threadId, explicit, chatType, mode, root) => {
      expect(
        threading.resolveReplyTransport!({
          cfg: {},
          replyToId,
          threadId,
          replyToIsExplicit: explicit,
          replyDelivery: chatType ? { chatType, replyToMode: mode! } : undefined,
        }),
      ).toEqual({ replyToId: root, threadId: root });
    },
  );

  it("extracts explicit and implicit send thread evidence", () => {
    expect(
      actions.extractToolSend!({ args: { action: "send", to: "channel:C1", replyTo: "root-1" } }),
    ).toMatchObject({ to: "channel:C1", threadId: "root-1" });
    expect(actions.extractToolSend!({ args: { action: "send", to: "channel:C1" } })).toMatchObject({
      to: "channel:C1",
      threadImplicit: true,
    });
  });

  it("resolves the active root for same-channel sends", () => {
    const toolContext = {
      currentChannelId: "channel:C1",
      currentThreadTs: "root-1",
      currentMessageId: "child-1",
      replyToMode: "all" as const,
    };
    type Context = NonNullable<
      Parameters<NonNullable<typeof threading.resolveAutoThreadId>>[0]["toolContext"]
    >;
    const resolve = (context: Partial<Context> = {}, to = "channel:C1", replyToId?: string) =>
      threading.resolveAutoThreadId!({
        cfg: {},
        to,
        replyToId,
        toolContext: { ...toolContext, ...context },
      });
    expect(resolve({ replyToMode: "off" }, "channel:C1", "child-1")).toBe("root-1");
    expect(resolve({}, "channel:C2")).toBeUndefined();
    const bare = "tqfek9psh7fw8mpa5berwyytqw";
    expect(
      resolve({ currentChannelId: "channel:" + bare, currentMessageId: undefined }, bare),
    ).toBe("root-1");
    expect(resolve({}, "channel:C1", "other-root")).toBe("other-root");
    expect(
      resolve({ currentMessageId: "root-1", replyToMode: "first", hasRepliedRef: { value: true } }),
    ).toBeUndefined();
    expect(resolve({ currentMessageId: "root-1", replyToMode: "batched" })).toBeUndefined();
  });

  it("uses the configured default account's reply mode while keeping direct messages flat", () => {
    const cfg = config({
      defaultAccount: "alerts",
      replyToMode: "off",
      accounts: {
        alerts: {
          replyToMode: "all",
          botToken: "alerts-token",
          baseUrl: "https://alerts.example.com",
        },
      },
    });
    expect(threading.resolveReplyToMode!({ cfg, chatType: "channel" })).toBe("all");
    expect(threading.resolveReplyToMode!({ cfg, accountId: "alerts", chatType: "direct" })).toBe(
      "off",
    );
  });
});

describe("Mattermost actions", () => {
  it("isolates discovery to available selected accounts and honors account overrides", () => {
    const cfg = config({
      actions: { messages: false, reactions: false },
      accounts: {
        default: { actions: { messages: false, reactions: false } },
        work: { botToken: "work-token", actions: { messages: true, reactions: true } },
        broken: {
          botToken: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_TEST_MISSING_MATTERMOST_TOKEN",
          },
        },
      },
    });
    expect(actions.describeMessageTool({ cfg })?.actions).toEqual(["send", "react", "read"]);
    expect(actions.describeMessageTool({ cfg, accountId: "default" })?.actions).toEqual(["send"]);
    expect(actions.describeMessageTool({ cfg, accountId: "work" })?.actions).toEqual([
      "send",
      "react",
      "read",
    ]);
    expect(actions.describeMessageTool({ cfg, accountId: "broken" })?.actions).toEqual([]);
    expect(
      actions.describeMessageTool({ cfg: { channels: { mattermost: { enabled: true } } } }),
    ).toMatchObject({ actions: [], capabilities: [] });
  });

  it("declines native sends in favor of durable outbound delivery", () => {
    expect(actions.supportsAction!({ action: "react" })).toBe(true);
    expect(actions.supportsAction!({ action: "read" })).toBe(true);
    expect(actions.supportsAction!({ action: "send" })).toBe(false);
    expect(actions.supportsAction!({ action: "poll" })).toBe(false);
    expect(actions.describeMessageTool({ cfg: config() })).toEqual({
      actions: ["send", "react"],
      capabilities: ["presentation"],
    });
    expect(
      actions.describeMessageTool({ cfg: config({ actions: { messages: false } }) })?.actions,
    ).toEqual(["send", "react"]);
  });

  it.each([
    ["react", "reactions", false],
    ["read", "messages", false],
    ["react", undefined, true],
  ] as const)(
    "blocks %s when feature=%s or account disabled=%s",
    async (kind, feature, disabled) => {
      const params = {
        target: "channel:CHAN1",
        to: "channel:CHAN1",
        messageId: "POST1",
        emoji: "thumbsup",
      };
      const cfg = config({
        accounts: { default: disabled ? { enabled: false } : { actions: { [feature!]: false } } },
        ...(feature ? { actions: { [feature]: true } } : {}),
      });
      await expectBlockedAction(
        {
          action: kind,
          params,
          cfg,
          ...(kind === "read" || disabled
            ? { accountId: "default", conversationReadOrigin: "direct-operator" as const }
            : {}),
        },
        disabled
          ? 'Mattermost account "default" is disabled'
          : `Mattermost ${feature === "messages" ? "message reads" : "reactions"} are disabled in config`,
      );
    },
  );

  it("reads posts into the shared JSON result with normalized timestamps", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(requestUrl(input)).toContain("/api/v4/channels/CURRENT/posts?per_page=2");
      return Response.json({
        order: ["post-2", "post-1"],
        posts: {
          "post-1": { id: "post-1", message: "older", create_at: 1_700_000_001_000 },
          "post-2": { id: "post-2", message: "newer", create_at: 1_700_000_002_000 },
        },
      });
    });
    const result = await runAction(
      {
        action: "read",
        params: { target: "channel:CURRENT", to: "channel:CURRENT", limit: 2 },
        cfg: config({ actions: { messages: true } }),
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "mattermost",
          currentChannelId: "channel:CURRENT",
        },
      },
      fetchImpl,
    );
    expect(result.details).toMatchObject({
      ok: true,
      channelId: "CURRENT",
      hasMore: false,
      messages: [
        { id: "post-2", message: "newer", timestampMs: 1_700_000_002_000 },
        { id: "post-1", message: "older", timestampMs: 1_700_000_001_000 },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid read cursors and limits before provider access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const params of [
      { target: "channel:CURRENT", before: "p1", after: "p2" },
      { target: "channel:CURRENT", limit: 0 },
    ]) {
      await expect(
        runAction(
          {
            action: "read",
            params,
            cfg: config({ actions: { messages: true } }),
            accountId: "default",
            conversationReadOrigin: "direct-operator",
          },
          fetchImpl,
        ),
      ).rejects.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects disabled accounts before opaque target resolution provider access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      withMockedGlobalFetch(fetchImpl, () =>
        mattermostPlugin.messaging!.targetResolver!.resolveTarget!({
          cfg: config({ accounts: { default: { enabled: false } } }),
          accountId: "default",
          input: "disabled12abcd1234abcd1234",
          normalized: "disabled12abcd1234abcd1234",
        }),
      ),
    ).rejects.toThrow('Mattermost account "default" is disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [
      "#town-square",
      "channel:CHAN1",
      "add",
      { postChannelId: "CHAN1" },
      "thumbsup",
      "Reacted with :thumbsup: on POST1",
    ],
    [
      "@alice",
      "user:PEER1",
      "remove",
      { postChannelId: "DMCHAN1", channelType: "D", channelName: "BOT123__PEER1" },
      "👍",
      "Removed reaction :thumbsup: from POST1",
    ],
  ] as const)(
    "uses the resolved target for %s",
    async (target, to, mode, fixture, emoji, expected) => {
      const result = await react(
        { target, to, emoji, remove: mode === "remove" },
        { ...fixture, mode },
      );
      expect(result.content).toEqual([{ type: "text", text: expected }]);
    },
  );

  it("preserves skin tone when adding a raw glyph reaction", async () => {
    const result = await react(
      { emoji: "👍🏽", remove: "true" },
      { emojiName: "thumbsup_medium_skin_tone" },
      { conversationReadOrigin: "direct-operator" },
    );
    expect(result.content).toEqual([
      { type: "text", text: "Reacted with :thumbsup_medium_skin_tone: on POST1" },
    ]);
    expect(result.details).toStrictEqual({});
  });

  it("forwards a prepared local attachment with trusted roots and a reader", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("report"));
    await sendPrepared({
      params: {
        attachmentText: "native attachment",
        attachments: [{ filePath: "/tmp/workspace/report.md", buffer: "", base64: "  " }],
      },
      accountId: "default",
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile,
    });
    expect(expectSend()).toMatchObject({
      attachmentText: "native attachment",
      mediaUrl: "/tmp/workspace/report.md",
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile,
      requireMediaUpload: true,
    });
  });

  it.each([
    [
      "multiple media",
      { media_urls: ["/tmp/one.md", "/tmp/two.md"] },
      "supports one attachment per message",
    ],
  ])("rejects prepared %s attachments", async (_name, params, error) => {
    await expect(sendPrepared({ params })).rejects.toThrow(error);
    expect(sendMessageMattermostMock).not.toHaveBeenCalled();
  });
});

describe("Mattermost outbound", () => {
  it.each(["text", "payload"] as const)(
    "reports %s provider progress before bookkeeping fails",
    async (mode) => {
      const onDeliveryResult = vi.fn();
      const { receipt } = sendResult("post-final", "provider-final");
      sendMessageMattermostMock.mockImplementationOnce(async (_to, _text, options) => {
        await options.onDeliveryResult?.({
          messageId: "post-final",
          channelId: "CHAN1",
          content: "provider-final",
          receipt,
        });
        throw new Error("activity store unavailable");
      });
      const ctx = {
        cfg: config(),
        to: "channel:CHAN1",
        text: "provider-final",
        onDeliveryResult,
        ...(mode === "text" ? { mediaUrl: "https://example.com/incidental.png" } : {}),
      };
      const pending =
        mode === "text"
          ? outbound.sendText!(ctx)
          : outbound.sendPayload!({
              ...ctx,
              payload: {
                text: ctx.text,
                channelData: { mattermost: { attachmentText: "attachment" } },
              },
            });
      await expect(pending).rejects.toThrow("activity store unavailable");
      expect(sendMessageMattermostMock.mock.calls[0]?.[2].mediaUrl).toBeUndefined();
      expect(onDeliveryResult).toHaveBeenCalledTimes(1);
      expect(onDeliveryResult).toHaveBeenCalledWith({
        channel: "mattermost",
        messageId: "post-final",
        target: { kind: "channel", id: "CHAN1" },
        content: "provider-final",
        receipt,
      });
    },
  );

  it("delivers presentation buttons with required local media and preserves card receipts", async () => {
    const mediaReadFile = makeMediaReader();
    const payload = await render(
      [
        { label: "Open", value: "open", style: "primary" },
        { label: "Docs", url: "https://example.com/docs" },
      ],
      ["Deploy finished"],
      { mediaUrl: "report.png" },
    );
    sendMessageMattermostMock.mockResolvedValueOnce(sendResult("post-1", "card", "card"));
    const result = await mattermostPlugin.message!.send!.payload!({
      ...outboundContext(""),
      payload: payload!,
      mediaAccess: mediaAccess(mediaReadFile),
    });
    const options = expectSend("Deploy finished\n\n- Open\n- Docs: https://example.com/docs");
    expect(options).toMatchObject({
      mediaUrl: "report.png",
      mediaLocalRoots,
      mediaReadFile,
      workspaceDir,
      requireMediaUpload: true,
    });
    expect(options.buttons).toStrictEqual([
      [
        {
          id: "open",
          text: "Open",
          callback_data: "open",
          context: { callback_data: "open" },
          style: "primary",
        },
      ],
    ]);
    expect(result.receipt.platformMessageIds).toEqual(["post-1"]);
    expect(result.receipt.parts[0]?.kind).toBe("card");
  });

  it("keeps typed navigation and approval actions on the text delivery path", async () => {
    const payload = await render([
      { label: "Review", action: { type: "url", url: "https://example.com/review" } },
      { label: "Open app", action: { type: "web-app", url: "https://example.com/app" } },
      {
        label: "Allow",
        action: {
          type: "approval",
          approvalId: "approval-1",
          approvalKind: "exec",
          decision: "allow-once",
        },
        value: "/approve approval-1 allow-once",
      },
    ]);
    const text =
      "- Review: https://example.com/review\n- Open app: https://example.com/app\n- Allow";
    expect(payload?.text).toBe(text);
    expect(payload?.channelData?.mattermost).toBeUndefined();
    await outbound.sendPayload!({ ...outboundContext(text), payload: payload! });
    const options = expectSend(text);
    expect(options.buttons).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain("approval-1");
    expect(JSON.stringify(options)).not.toContain("/approve");
  });

  it.each([
    {
      name: "hosted widget without a URL",
      buttons: [
        {
          label: "Hosted widget",
          action: {
            type: "web-app",
            widgetId: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        },
      ] satisfies Button[],
      texts: ["Widget"],
      extras: {},
    },
    {
      name: "multi-media presentation",
      buttons: [{ label: "Open", value: "open" }],
      texts: [],
      extras: { mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"] },
    },
  ])("keeps $name on the fallback path", async ({ buttons, texts, extras }) => {
    expect(await render(buttons, texts, extras)).toBeNull();
  });

  it("uses a thread as fallback for media delivery with structured workspace access", async () => {
    const mediaReadFile = makeMediaReader();
    await outbound.sendMedia!({
      ...outboundContext("caption"),
      mediaUrl: "image.png",
      threadId: "post-root",
      mediaAccess: mediaAccess(mediaReadFile),
    });
    expect(expectSend("caption")).toMatchObject({
      replyToId: "post-root",
      mediaUrl: "image.png",
      mediaLocalRoots,
      mediaReadFile,
      workspaceDir,
      requireMediaUpload: true,
    });
  });
});
