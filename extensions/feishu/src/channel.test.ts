import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { feishuPlugin } from "../channel-plugin-api.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER } from "./outbound.js";
import { looksLikeFeishuId } from "./targets.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const addReactionFeishuMock = vi.hoisted(() => vi.fn());
const listReactionsFeishuMock = vi.hoisted(() => vi.fn());
const removeReactionFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendStickerFeishuMock = vi.hoisted(() => vi.fn());
const getMessageFeishuMock = vi.hoisted(() => vi.fn());
const editMessageFeishuMock = vi.hoisted(() => vi.fn());
const createPinFeishuMock = vi.hoisted(() => vi.fn());
const listPinsFeishuMock = vi.hoisted(() => vi.fn());
const removePinFeishuMock = vi.hoisted(() => vi.fn());
const getChatInfoMock = vi.hoisted(() => vi.fn());
const getChatMembersMock = vi.hoisted(() => vi.fn());
const assertFeishuChatMemberMock = vi.hoisted(() => vi.fn());
const getFeishuMemberInfoMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryPeersLiveMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryGroupsLiveMock = vi.hoisted(() => vi.fn());
const feishuOutboundSendTextMock = vi.hoisted(() => vi.fn());
const feishuOutboundSendMediaMock = vi.hoisted(() => vi.fn());
const feishuOutboundSendPayloadMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    addReactionFeishu: addReactionFeishuMock,
    createPinFeishu: createPinFeishuMock,
    editMessageFeishu: editMessageFeishuMock,
    getChatInfo: getChatInfoMock,
    getChatMembers: getChatMembersMock,
    assertFeishuChatMember: assertFeishuChatMemberMock,
    getFeishuMemberInfo: getFeishuMemberInfoMock,
    getMessageFeishu: getMessageFeishuMock,
    listFeishuDirectoryGroupsLive: listFeishuDirectoryGroupsLiveMock,
    listFeishuDirectoryPeersLive: listFeishuDirectoryPeersLiveMock,
    listPinsFeishu: listPinsFeishuMock,
    listReactionsFeishu: listReactionsFeishuMock,
    probeFeishu: probeFeishuMock,
    removePinFeishu: removePinFeishuMock,
    removeReactionFeishu: removeReactionFeishuMock,
    sendCardFeishu: sendCardFeishuMock,
    sendMessageFeishu: sendMessageFeishuMock,
    sendStickerFeishu: sendStickerFeishuMock,
    feishuOutbound: {
      sendText: feishuOutboundSendTextMock,
      sendMedia: feishuOutboundSendMediaMock,
      sendPayload: feishuOutboundSendPayloadMock,
    },
  },
}));

const cfg = {
  channels: {
    feishu: {
      enabled: true,
      appId: "cli_main",
      appSecret: "secret_main",
      actions: { reactions: true },
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
    },
  },
} satisfies OpenClawConfig;
const actionContext = { cfg, accountId: undefined };
type Action = ChannelMessageActionContext["action"];
type Context = Partial<Omit<ChannelMessageActionContext, "action" | "params">>;
const directOperatorContext: Context = { conversationReadOrigin: "direct-operator" };
type FeishuConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["feishu"]>;
const config = (feishu: Partial<FeishuConfig>): OpenClawConfig => ({
  channels: { feishu: { appId: "cli_main", appSecret: "secret_main", ...feishu } },
});
const run = (action: Action, params: Record<string, unknown>, context: Context = {}) =>
  feishuPlugin.actions!.handleAction!({ channel: "feishu", cfg, action, params, ...context });
const requireRecord = createRequireRecord("record", "expected-label-capitalized");
function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected array");
  }
  return value;
}
const details = (result: unknown) =>
  requireRecord(requireRecord(result, "result").details, "details");
const args = (mock: { mock: { calls: unknown[][] } }) =>
  requireRecord(mock.mock.calls[0]?.[0], "args");
const card = () => requireRecord(args(sendCardFeishuMock).card, "card");
const elements = () => requireRecord(card().body, "body").elements;
const receipt = { messageId: "om_sent", chatId: "oc_group_1" };
const textDelivery = () =>
  feishuOutboundSendTextMock.mockResolvedValueOnce({
    channel: "feishu",
    messageId: "om_sent",
    target: { kind: "chat", id: "oc_provider_authoritative" },
  });
const fetched = (chatId = "oc_group_1", chatType: "group" | "private" = "group") => ({
  messageId: "om_1",
  chatId,
  chatType,
  content: "hello",
  contentType: "text",
});
const topicContext = {
  sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
  toolContext: { currentChannelId: "oc_group_1", currentMessageId: "om_inbound" },
};
const currentReadContext: Context = {
  accountId: "default",
  requesterAccountId: "default",
  toolContext: {
    currentChannelProvider: "feishu",
    currentChannelId: "oc_group_1",
    currentChatType: "group",
  },
};
const policyCfg = config({ groupPolicy: "open", dmPolicy: "pairing" });
const blockedCfg = config({
  groupPolicy: "allowlist",
  groups: { oc_allowed: {} },
  actions: { reactions: true },
});
const getActions = (localCfg: OpenClawConfig, accountId?: string) =>
  feishuPlugin.actions!.describeMessageTool({ cfg: localCfg, accountId });

beforeEach(() => {
  vi.resetAllMocks();
  createFeishuClientMock.mockReturnValue({ tag: "client" });
  getChatInfoMock.mockResolvedValue({
    chat_id: "oc_group_1",
    chat_mode: "group",
    chat_type: "private",
  });
});
afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./channel.runtime.js");
  vi.resetModules();
});

describe("Feishu plugin adapters", () => {
  it("distinguishes users from chats", () => {
    expect(feishuPlugin.messaging?.inferTargetChatType?.({ to: "ou_owner" })).toBe("direct");
    expect(feishuPlugin.messaging?.inferTargetChatType?.({ to: "oc_group" })).toBe("group");
  });
  it("reports open groups as a non-blocking advisory", async () => {
    const account = feishuPlugin.config.resolveAccount(cfg, "default");
    expect(
      await feishuPlugin.security?.collectWarnings?.({ cfg, accountId: "default", account }),
    ).toMatchObject([{ checkId: "channels.feishu.groups.open", severity: "warn" }]);
  });
  it("probes the selected account credentials", async () => {
    const localCfg = config({
      accounts: { main: { appId: "cli_selected", appSecret: "secret_selected" } },
    });
    const account = feishuPlugin.config.resolveAccount(localCfg, "main");
    probeFeishuMock.mockResolvedValueOnce({ ok: true, appId: "cli_selected" });
    expect(
      await feishuPlugin.status?.probeAccount?.({ account, cfg: localCfg, timeoutMs: 1000 }),
    ).toEqual({ ok: true, appId: "cli_selected" });
    expect(probeFeishuMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        accountId: "main",
        appId: "cli_selected",
        appSecret: "secret_selected",
      }),
    );
  });
  it("preserves the pairing approval account", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce(receipt);
    await feishuPlugin.pairing?.notifyApproval?.({ cfg, id: "ou_user", accountId: "work" });
    expect(sendMessageFeishuMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cfg, to: "ou_user", accountId: "work" }),
    );
  });
  it("owns topic and sender session inheritance", () => {
    for (const [rawId, parents] of [
      ["oc_group:Topic:om_root:Sender:ou_user", ["oc_group:topic:om_root", "oc_group"]],
      ["oc_group:topic:om_root", ["oc_group"]],
    ] as const) {
      expect(
        feishuPlugin.messaging?.resolveSessionConversation?.({ kind: "group", rawId }),
      ).toEqual({
        id: rawId.toLowerCase(),
        baseConversationId: "oc_group",
        parentConversationCandidates: parents,
      });
    }
  });
  it.each([
    ["ou_123", { to: "user:ou_123" }],
    ["oc_123", { to: "chat:oc_123" }],
    ["oc_123:topic:omt_456", { to: "chat:oc_123", threadId: "omt_456" }],
  ] as const)("resolves delivery for %s", (conversationId, expected) => {
    expect(
      feishuPlugin.messaging?.resolveDeliveryTarget?.({
        conversationId,
        parentConversationId: conversationId.includes(":topic:") ? "oc_123" : undefined,
      }),
    ).toEqual(expected);
  });
  it("keeps native chat identity separate from delivery routing", () => {
    expect(
      feishuPlugin.threading?.buildToolContext?.({
        cfg,
        context: { To: "user:ou_sender", NativeChannelId: "oc_direct_chat", ChatType: "direct" },
      }),
    ).toMatchObject({
      currentChannelId: "oc_direct_chat",
      currentChatType: "direct",
      currentMessagingTarget: "user:ou_sender",
    });
  });
  it("recognizes provider-prefixed targets", () => {
    expect(looksLikeFeishuId("feishu:user:ou_123")).toBe(true);
  });

  it("declares exact native chat types", () => {
    expect(feishuPlugin.capabilities.chatTypes).toEqual(["direct", "group"]);
  });
});

describe("Feishu discovery", () => {
  it.each([
    {
      provider: { source: "env", allowlist: ["OTHER_SECRET"] },
      defaultEnv: "corp-env",
      allowed: false,
    },
    {
      provider: { source: "env", allowlist: ["FEISHU_DISCOVERY_SECRET"] },
      defaultEnv: "corp-env",
      allowed: true,
    },
  ] satisfies Array<{
    provider: NonNullable<NonNullable<OpenClawConfig["secrets"]>["providers"]>[string];
    defaultEnv: string;
    allowed: boolean;
  }>)("enforces SecretRef provider policy: %j", ({ provider, defaultEnv, allowed }) => {
    vi.stubEnv("FEISHU_DISCOVERY_SECRET", "ambient-secret");
    try {
      const discovery = getActions({
        secrets: { defaults: { env: defaultEnv }, providers: { "corp-env": provider } },
        ...config({
          appSecret: { source: "env", provider: "corp-env", id: "FEISHU_DISCOVERY_SECRET" },
        }),
      });
      expect(discovery?.capabilities).toEqual(allowed ? ["presentation"] : []);
      if (allowed) {
        expect(discovery?.actions).toContain("send");
      } else {
        expect(discovery?.actions).toEqual([]);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("uses selected-account reaction policy", () => {
    const localCfg = config({
      actions: { reactions: false },
      accounts: {
        default: { actions: { reactions: false } },
        work: { actions: { reactions: true } },
      },
    });
    expect(getActions(localCfg, "default")?.actions).not.toContain("react");
    expect(getActions(localCfg, "work")?.actions).toContain("react");
  });
});

const stickerCfg = config({
  appId: undefined,
  appSecret: undefined,
  defaultAccount: "work",
  actions: { sticker: true },
  stickerSets: {
    bot_work: {
      file_work: ["Thumbs Up", "赞👍", "thumbs up again"],
      file_wave: ["Wave.*", "你好👋"],
    },
    bot_other: { file_other: ["赞👍"] },
  },
  accounts: {
    work: { appId: "bot_work", appSecret: "secret_work" },
    renamed: { appId: "bot_work", appSecret: "rotated_secret" },
    other: { appId: "bot_other", appSecret: "secret_other" },
    missing: { appId: "bot_missing", appSecret: "secret_missing" },
    off: { appId: "bot_work", appSecret: "secret_work", actions: { sticker: false } },
    replaced: { appId: "bot_work", appSecret: "secret_work", actions: { reactions: true } },
    disabled: { appId: "bot_work", appSecret: "secret_work", enabled: false },
    unconfigured: { appId: "bot_work", appSecret: undefined },
  },
});
const search = (params: Record<string, unknown>, accountId = "work", localCfg = stickerCfg) =>
  run("sticker-search", params, { cfg: localCfg, accountId });

describe("Feishu stickers", () => {
  it("advertises and admits stickers only for enabled configured accounts", async () => {
    expect(getActions(cfg)?.actions).not.toContain("sticker");
    expect(getActions(stickerCfg)?.actions).toContain("sticker");
    expect(getActions(stickerCfg, "work")?.actions).toContain("sticker-search");
    expect(
      feishuPlugin.agentPrompt
        ?.messageToolHints?.({ cfg: stickerCfg, accountId: "work" })
        ?.join("\n"),
    ).toContain("configured keyword");
    for (const accountId of ["off", "replaced", "disabled", "unconfigured"]) {
      expect(getActions(stickerCfg, accountId)?.actions).not.toContain("sticker");
      expect(
        feishuPlugin.agentPrompt?.messageToolHints?.({ cfg: stickerCfg, accountId })?.join("\n"),
      ).not.toContain("fileId");
      await expect(search({ query: "赞" }, accountId)).rejects.toThrow("actions.sticker");
    }
    const disabled = config({ ...stickerCfg.channels?.feishu, enabled: false });
    expect(getActions(disabled, "work")?.actions).not.toContain("sticker-search");
    await expect(search({ query: "赞" }, "work", disabled)).rejects.toThrow("actions.sticker");
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });
  it.each([
    { name: "absent", stickerSets: undefined },
    { name: "empty", stickerSets: { bot_work: {} } },
    { name: "inherited", stickerSets: Object.create({ bot_work: { file_work: ["赞"] } }) },
    {
      name: "different bot",
      accountId: "missing",
      stickerSets: stickerCfg.channels?.feishu?.stickerSets,
    },
    {
      name: "replaced bot",
      accounts: { work: { appId: "replacement", appSecret: "secret_new" } },
      stickerSets: stickerCfg.channels?.feishu?.stickerSets,
    },
  ])("rejects a $name sticker catalog", async ({ stickerSets, accountId = "work", accounts }) => {
    const localCfg = config({
      ...stickerCfg.channels?.feishu,
      stickerSets,
      ...(accounts ? { accounts } : {}),
    });
    expect(getActions(localCfg, accountId)?.actions).not.toContain("sticker-search");
    await expect(search({ query: "赞" }, accountId, localCfg)).rejects.toThrow("stickerSets");
  });
  it.each([
    ["work", " thUMbs ", "file_work", "Thumbs Up"],
    ["renamed", "赞", "file_work", "赞👍"],
    ["other", "赞", "file_other", "赞👍"],
  ])("searches the catalog owned by %s for %s", async (accountId, query, fileId, keyword) => {
    expect(details(await search({ query }, accountId))).toEqual({
      stickers: [{ fileId, keyword }],
      truncated: false,
    });
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });
  it.each([
    { params: { query: "👍".repeat(129) }, error: "query" },
    ...["5", 0, 1.5, 11].map((limit) => ({ params: { query: "赞", limit }, error: "limit" })),
  ])("rejects invalid sticker search input %j", async ({ params, error }) => {
    await expect(search(params)).rejects.toThrow(error);
  });
  it.each(["count", "bytes"] as const)("bounds sticker search by %s", async (bound) => {
    const bytes = bound === "bytes";
    const keyword = bytes ? "\u0001".repeat(64) : "match";
    const keys = Array.from({ length: bytes ? 8 : 6 }, (_, i) =>
      bytes ? "👍".repeat(511) + String.fromCodePoint(0x1f600 + i) : `file_${i}`,
    );
    const localCfg = config({
      ...stickerCfg.channels?.feishu,
      stickerSets: { bot_work: Object.fromEntries(keys.map((key) => [key, [keyword]])) },
    });
    const result = await search(
      { query: keyword, limit: bytes ? 10 : undefined },
      "work",
      localCfg,
    );
    const value = details(result);
    expect(value).toEqual({
      stickers: keys.slice(0, bytes ? 1 : 5).map((fileId) => ({ fileId, keyword })),
      truncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(3072);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(value) }]);
  });
  it.each([
    {
      name: "found on a renamed account",
      accountId: "renamed",
      lookup: true,
      params: { to: "oc_group_1" },
      replyToMessageId: undefined,
      replyInThread: false,
    },
    {
      name: "explicit reply",
      params: { stickerId: ["file_sticker", "ignored"], replyTo: "om_parent" },
      replyToMessageId: "om_parent",
      replyInThread: false,
    },
    {
      name: "explicit thread",
      params: { fileId: " file_sticker ", threadId: "om_thread", topLevel: true },
      replyToMessageId: "om_thread",
      replyInThread: true,
    },
    {
      name: "inherited thread",
      params: { fileId: "file_sticker" },
      replyToMessageId: "om_inbound",
      replyInThread: true,
    },
  ])(
    "dispatches stickers: $name",
    async ({ accountId = "work", lookup, params, replyToMessageId, replyInThread }) => {
      sendStickerFeishuMock.mockResolvedValueOnce(receipt);
      const matches = lookup
        ? details(await search({ query: "赞" }, accountId)).stickers
        : undefined;
      if (lookup) {
        expect(matches).toEqual([{ fileId: "file_work", keyword: "赞👍" }]);
      }
      const match = lookup ? requireRecord(requireArray(matches)[0], "sticker") : {};
      const result = await run(
        "sticker",
        { ...match, ...params },
        { ...(lookup ? {} : topicContext), cfg: stickerCfg, accountId },
      );
      expect(details(result)).toMatchObject({ ok: true, action: "sticker", ...receipt });
      expect(sendStickerFeishuMock).toHaveBeenCalledExactlyOnceWith({
        cfg: stickerCfg,
        to: "oc_group_1",
        fileKey: lookup ? "file_work" : "file_sticker",
        accountId,
        replyToMessageId,
        replyInThread,
      });
    },
  );
  it.each([{}, { fileId: "../bad" }])(
    "rejects missing or invalid sticker keys: %j",
    async (params) => {
      await expect(
        run("sticker", { to: "oc_group_1", ...params }, { cfg: stickerCfg, accountId: "work" }),
      ).rejects.toThrow("previously received");
      expect(sendStickerFeishuMock).not.toHaveBeenCalled();
    },
  );
});

const rawCard = {
  schema: "2.0",
  header: { title: { tag: "plain_text", content: "Raw card" } },
  body: { elements: [{ tag: "markdown", content: "Raw card" }] },
};
const oversizedPresentation = {
  blocks: [
    {
      type: "table",
      caption: "Large pipeline",
      headers: ["Account", "Stage"],
      rows: Array.from({ length: 400 }, (_, i) => [`account-${i}-${"x".repeat(80)}`, "Review"]),
    },
  ],
};
const mediaAccess = {
  localRoots: ["/approved/workspace"],
  workspaceDir: "/approved/workspace",
  readFile: async () => Buffer.from("approved image"),
};
const legacyReadFile = async () => Buffer.from("legacy image");
const forgedMediaAccess = { localRoots: ["/forged/workspace"], workspaceDir: "/forged/workspace" };
const trustedMediaContext = {
  mediaAccess,
  mediaLocalRoots: ["/legacy/workspace"],
  mediaReadFile: legacyReadFile,
};
const forgedMediaParams = {
  mediaAccess: forgedMediaAccess,
  mediaLocalRoots: ["/forged/workspace"],
  mediaReadFile: vi.fn(),
};

describe("Feishu cards and delivery", () => {
  it.each([
    {
      name: "thread fanout",
      action: "thread-reply",
      params: { to: "chat:oc_requested_alias", text: "明".repeat(11_000), messageId: "om_parent" },
      context: { cfg: config({ ...cfg.channels.feishu, renderMode: "raw" }) },
    },
    {
      name: "ordinary JSON",
      params: { message: JSON.stringify({ ok: true, elements: "not-a-card" }) },
    },
    {
      name: "blank attachment fields",
      params: {
        message: "see attached",
        file: " ",
        buffer: "",
        base64: " ",
        media: " ",
        mediaUrls: [" "],
      },
      context: { mediaLocalRoots: ["/tmp"] },
    },
  ] satisfies Array<{
    name: string;
    action?: "send" | "thread-reply";
    params: Record<string, unknown>;
    context?: Context;
  }>)(
    "uses canonical text delivery for $name",
    async ({ action: requestedAction, params, context }) => {
      const action = requestedAction ?? "send";
      textDelivery();
      const to = params.to ?? "chat:oc_group_1";
      const text = params.text ?? params.message;
      const result = await run(action, { ...params, to }, context);
      expect(feishuOutboundSendTextMock).toHaveBeenCalledExactlyOnceWith({
        cfg: context?.cfg ?? cfg,
        accountId: undefined,
        to,
        text,
        mediaLocalRoots: context?.mediaLocalRoots,
        ...(action === "thread-reply" ? { threadId: "om_parent" } : { replyToId: undefined }),
      });
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
      expect(details(result)).toMatchObject({
        ok: true,
        action,
        messageId: "om_sent",
        chatId: "oc_provider_authoritative",
      });
    },
  );
  it("rejects native cards combined with media", async () => {
    await expect(
      run("send", {
        to: "chat:oc_group_1",
        message: JSON.stringify(rawCard),
        media: "/tmp/image.png",
      }),
    ).rejects.toThrow("does not support card with media");
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
    expect(feishuOutboundSendTextMock).not.toHaveBeenCalled();
  });
  it("falls back when presentation text exceeds the card table limit", async () => {
    feishuOutboundSendPayloadMock.mockResolvedValueOnce(receipt);
    const sixTables = Array.from(
      { length: 6 },
      (_, i) => `| a${i} | b${i} |\n| - | - |\n| 1 | 2 |`,
    ).join("\n\n");
    expect(
      details(
        await run("send", {
          to: "chat:oc_group_1",
          message: sixTables,
          presentation: { title: "Status", blocks: [{ type: "text", text: "Build completed" }] },
        }),
      ),
    ).toMatchObject({ ok: true, messageId: "om_sent" });
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(feishuOutboundSendPayloadMock).toHaveBeenCalledOnce();
    expect(args(feishuOutboundSendPayloadMock)).toMatchObject({
      to: "chat:oc_group_1",
      text: sixTables,
    });
  });
  it("hides raw card JSON and preserves trusted media access in oversized fallbacks", async () => {
    feishuOutboundSendPayloadMock.mockResolvedValueOnce(receipt);
    await run(
      "send",
      {
        to: "chat:oc_group_1",
        message: `[Nexus] ${JSON.stringify(rawCard)}`,
        presentation: oversizedPresentation,
        media: "pipeline.png",
        ...forgedMediaParams,
      },
      {
        cfg: config({ ...cfg.channels.feishu, responsePrefix: "[Nexus]" }),
        ...trustedMediaContext,
      },
    );
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(feishuOutboundSendPayloadMock).toHaveBeenCalledOnce();
    const sent = args(feishuOutboundSendPayloadMock);
    expect(sent).toMatchObject({
      text: "",
      mediaLocalRoots: ["/legacy/workspace"],
      mediaReadFile: legacyReadFile,
      payload: { presentation: oversizedPresentation, mediaUrl: "pipeline.png", text: undefined },
    });
    expect(sent.mediaAccess).toBe(mediaAccess);
    expect(sent.mediaAccess).not.toBe(forgedMediaAccess);
  });
  it("propagates upload failure from the presentation fallback (#125664)", async () => {
    feishuOutboundSendPayloadMock.mockRejectedValueOnce(new Error("upload failed"));
    await expect(
      run(
        "send",
        { to: "chat:oc_group_1", presentation: oversizedPresentation, media: "pipeline.png" },
        trustedMediaContext,
      ),
    ).rejects.toThrow("upload failed");
    expect(feishuOutboundSendPayloadMock).toHaveBeenCalledOnce();
    const payload = requireRecord(args(feishuOutboundSendPayloadMock).payload, "payload");
    const channelData = requireRecord(payload.channelData, "channelData");
    expect(
      requireRecord(channelData.feishu, "feishu")[FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER],
    ).toBe(true);
  });
  it.each([
    {
      name: "legacy wrapped replies",
      action: "thread-reply",
      params: {
        messageId: "om_parent",
        text: JSON.stringify({
          type: "interactive",
          card: {
            header: { title: { tag: "plain_text", content: "Legacy card" }, template: "green" },
            elements: [
              {
                tag: "div",
                text: { tag: "lark_md", content: '**Legacy** <at id="ou_1">body</at>' },
              },
              { tag: "div", text: { tag: "plain_text", content: "Literal *text*" } },
            ],
          },
        }),
      },
      header: { title: { tag: "plain_text", content: "Legacy card" }, template: "green" },
      elements: [
        { tag: "markdown", content: '**Legacy** &lt;at id="ou_1"&gt;body&lt;/at&gt;' },
        { tag: "markdown", content: "Literal \\*text\\*" },
      ],
    },
    {
      name: "native JSON after the configured prefix",
      params: { message: `[Nexus] ${JSON.stringify(rawCard)}` },
      context: { cfg: { messages: { responsePrefix: "[Nexus]" } } },
      header: { ...rawCard.header, template: "blue" },
      elements: rawCard.body.elements,
    },
    {
      name: "structured presentation before native JSON",
      params: {
        message: JSON.stringify(rawCard),
        presentation: {
          title: "Structured card",
          blocks: [{ type: "text", text: "Structured body" }],
        },
      },
      header: { title: { tag: "plain_text", content: "Structured card" }, template: "blue" },
      elements: [{ tag: "markdown", content: "Structured body" }],
    },
    {
      name: "unsupported labels alongside native commands and URLs",
      action: "thread-reply",
      params: {
        messageId: "om_root",
        text: "Choose an action",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Inspect", action: { type: "callback", value: "inspect:123" } },
                { label: "Help", action: { type: "command", command: "/help" } },
                {
                  label: "Details <one> & more",
                  action: { type: "callback", value: "/opaque-details" },
                },
                { label: "Docs", action: { type: "url", url: "https://example.com" } },
              ],
            },
          ],
        },
      },
      elements: [
        { tag: "markdown", content: "Choose an action" },
        { tag: "markdown", content: "- Inspect" },
        expect.objectContaining({
          tag: "button",
          text: { tag: "plain_text", content: "Help" },
          behaviors: [
            {
              type: "callback",
              value: { oc: "ocf1", k: "quick", a: "feishu.payload.button", q: "/help" },
            },
          ],
        }),
        { tag: "markdown", content: "- Details &lt;one&gt; &amp; more" },
        expect.objectContaining({
          tag: "button",
          text: { tag: "plain_text", content: "Docs" },
          behaviors: [{ type: "open_url", default_url: "https://example.com" }],
        }),
      ],
    },
    {
      name: "disabled controls without interactions",
      params: {
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Unavailable [command](https://example.com/label)",
                  disabled: true,
                  action: { type: "command", command: "/help" },
                },
                {
                  label: "Unavailable link",
                  disabled: true,
                  action: { type: "url", url: "https://example.com" },
                },
              ],
            },
          ],
        },
      },
      elements: [
        { tag: "markdown", content: "- Unavailable \\[command\\]\\(https://example.com/label\\)" },
        { tag: "markdown", content: "- Unavailable link" },
      ],
    },
    {
      name: "legacy web_app links",
      params: {
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Open app", web_app: { url: "https://example.com/app" } }],
            },
          ],
        },
      },
      elements: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "Open app" },
          type: "default",
          behaviors: [{ type: "open_url", default_url: "https://example.com/app" }],
        },
      ],
    },
    {
      name: "select commands without opaque callback values",
      params: {
        presentation: {
          blocks: [
            {
              type: "select",
              placeholder: "Pick <one> & continue",
              options: [
                { label: "Status <one>", action: { type: "command", command: "/status" } },
                { label: "Callback", action: { type: "callback", value: "/opaque-callback" } },
                { label: "Legacy", value: "/opaque-legacy" },
              ],
            },
          ],
        },
      },
      elements: [
        {
          tag: "markdown",
          content:
            "Pick &lt;one&gt; &amp; continue:\n- Status &lt;one&gt;: `/status`\n- Callback\n- Legacy",
        },
      ],
    },
  ] satisfies Array<{
    name: string;
    action?: "send" | "thread-reply";
    params: Record<string, unknown>;
    context?: Context;
    header?: Record<string, unknown>;
    elements: unknown[];
  }>)(
    "renders $name",
    async ({ action: requestedAction, params, context, header, elements: expectedElements }) => {
      const action = requestedAction ?? "send";
      sendCardFeishuMock.mockResolvedValueOnce(receipt);
      expect(
        details(await run(action, { to: "chat:oc_group_1", ...params }, context)),
      ).toMatchObject({ ok: true, ...receipt });
      expect(elements()).toEqual(expectedElements);
      expect(card().header).toEqual(header);
      expect(args(sendCardFeishuMock)).toMatchObject({
        replyToMessageId: params.messageId,
        replyInThread: action === "thread-reply",
      });
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );
});

const sendAttachment = (
  params: Record<string, unknown>,
  action: "send" | "thread-reply" = "send",
) =>
  run(
    action,
    {
      to: "chat:oc_group_1",
      message: "see attached",
      ...(action === "thread-reply" ? { messageId: "om_parent" } : {}),
      ...params,
    },
    { mediaLocalRoots: ["/tmp"] },
  );

describe("Feishu attachment intent", () => {
  it.each([
    { action: "thread-reply", params: { media: "/tmp/media.png" } },
    { action: "send", params: { media_urls: "/tmp/media.png" } },
    { action: "send", params: { attachments: [{ mediaUrls: ["/tmp/media.png"] }] } },
  ] as const)(
    "promotes scalar, snake-case and nested media sources: %j",
    async ({ action, params }) => {
      feishuOutboundSendMediaMock.mockResolvedValueOnce({ channel: "feishu", ...receipt });
      await sendAttachment(params, action);
      expect(feishuOutboundSendMediaMock).toHaveBeenCalledOnce();
      expect(args(feishuOutboundSendMediaMock)).toMatchObject({
        mediaUrl: "/tmp/media.png",
        ...(action === "thread-reply"
          ? { threadId: "om_parent" }
          : { propagateMediaUploadFailure: true }),
      });
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );
  it.each([
    { params: { buffer: {} }, error: "buffer/base64 payloads are not supported" },
    {
      params: { attachments: [{ filePath: "/tmp/report.md" }, { buffer: "aGVsbG8=" }] },
      error: "buffer/base64 payloads are not supported",
    },
    {
      params: { file: "/tmp/script.py" },
      error: "`file` attachment-intent parameter is not supported",
    },
    {
      params: { attachments: [{ file: {} }] },
      error: "`file` attachment-intent parameter is not supported",
    },
    { params: { mediaUrls: ["/tmp/a.png", "/tmp/b.png"] }, error: "single media attachment" },
    { params: { attachments: [{ media: {} }] }, error: "a present malformed media source value" },
    { params: { mediaUrls: [{}] }, error: "a present malformed media source value" },
    {
      params: { attachments: { media: "/tmp/a.png" } },
      error: "a present malformed media source value",
    },
    { params: { attachments: [null] }, error: "a present malformed media source value" },
  ])("rejects unrepresentable attachment intent before delivery: %j", async ({ params, error }) => {
    await expect(sendAttachment(params)).rejects.toThrow(error);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(feishuOutboundSendTextMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(feishuOutboundSendMediaMock).not.toHaveBeenCalled();
  });
  it.each([
    { action: "send", media: true },
    { action: "thread-reply", media: false },
  ] as const)("uses only trusted workspace authority for $action", async ({ action, media }) => {
    const sender = media ? feishuOutboundSendMediaMock : feishuOutboundSendTextMock;
    sender.mockResolvedValueOnce({ channel: "feishu", ...receipt });
    const result = await run(
      action,
      {
        to: "chat:oc_group_1",
        ...forgedMediaParams,
        ...(media
          ? { mediaUrl: "image.png", asVoice: true }
          : { text: "test", messageId: "om_parent" }),
      },
      trustedMediaContext,
    );
    expect(sender).toHaveBeenCalledExactlyOnceWith({
      ...actionContext,
      to: "chat:oc_group_1",
      text: media ? "" : "test",
      ...trustedMediaContext,
      ...(media
        ? {
            mediaUrl: "image.png",
            audioAsVoice: true,
            propagateMediaUploadFailure: true,
            replyToId: undefined,
          }
        : { threadId: "om_parent" }),
    });
    expect(args(sender).mediaAccess).toBe(mediaAccess);
    expect(args(sender).mediaAccess).not.toBe(forgedMediaAccess);
    expect(details(result).messageId).toBe("om_sent");
  });
});

describe("Feishu conversation reads and mutations", () => {
  it.each(["found", "missing"] as const)(
    "reads an authorized group message: %s",
    async (outcome) => {
      const found = outcome === "found";
      const messageId = found ? "om_1" : "om_missing";
      getMessageFeishuMock.mockResolvedValueOnce(found ? fetched() : null);
      const result = await run(
        "read",
        { messageId, chatId: "oc_group_1" },
        found ? { cfg: config({ groupPolicy: "allowlist", groupAllowFrom: ["oc_group_1"] }) } : {},
      );
      if (!found) {
        expect(result).toMatchObject({
          isError: true,
          details: { error: "Feishu read failed or message not found: om_missing" },
        });
        return;
      }
      expect(details(result)).toMatchObject({ ok: true, action: "read", message: fetched() });
      expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_group_1");
      expect(getMessageFeishuMock).toHaveBeenCalledOnce();
      const metadataOrder = getChatInfoMock.mock.invocationCallOrder[0];
      const messageOrder = getMessageFeishuMock.mock.invocationCallOrder[0];
      if (metadataOrder === undefined || messageOrder === undefined) {
        throw new Error("Expected metadata and message reads");
      }
      expect(metadataOrder).toBeLessThan(messageOrder);
    },
  );
  it("does not mistake private group visibility for a direct conversation", async () => {
    getMessageFeishuMock.mockResolvedValueOnce(fetched("oc_group_1", "private"));
    await expect(
      run(
        "read",
        { messageId: "om_1" },
        {
          ...currentReadContext,
          cfg: config({ groupPolicy: "disabled", dmPolicy: "open", allowFrom: ["*"] }),
          toolContext: {
            currentChannelProvider: "feishu",
            currentChannelId: "oc_group_1",
            currentChatType: "direct",
          },
        },
      ),
    ).rejects.toThrow("Feishu read target is not allowed.");
    expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_group_1");
  });
  it.each(["edit", "pin", "unpin"] as const)(
    "authorizes direct-operator %s mutations",
    async (action) => {
      getMessageFeishuMock.mockResolvedValueOnce(fetched());
      const result = {
        messageId: "om_1",
        ...(action === "edit" ? { contentType: "post" } : { chatId: "oc_group_1" }),
      };
      const mutate =
        action === "edit"
          ? editMessageFeishuMock
          : action === "pin"
            ? createPinFeishuMock
            : removePinFeishuMock;
      mutate.mockResolvedValueOnce(result);
      const params = { messageId: "om_1", ...(action === "edit" ? { text: "updated" } : {}) };
      expect(details(await run(action, params, directOperatorContext))).toMatchObject({
        ok: true,
        ...(action === "pin"
          ? { pin: { messageId: "om_1" } }
          : action === "edit"
            ? { messageId: "om_1", contentType: "post" }
            : { messageId: "om_1" }),
      });
      expect(mutate).toHaveBeenCalledExactlyOnceWith({
        ...actionContext,
        ...params,
        ...(action === "edit" ? { card: undefined } : {}),
      });
    },
  );
  it("lists pins from an authorized chat", async () => {
    listPinsFeishuMock.mockResolvedValueOnce({
      chatId: "oc_group_1",
      pins: [{ messageId: "om_pin" }],
      hasMore: false,
    });
    expect(details(await run("list-pins", { chatId: "oc_group_1" }))).toMatchObject({
      ok: true,
      pins: [{ messageId: "om_pin" }],
    });
    expect(listPinsFeishuMock).toHaveBeenCalledExactlyOnceWith({
      ...actionContext,
      chatId: "oc_group_1",
      startTime: undefined,
      endTime: undefined,
      pageSize: undefined,
      pageToken: undefined,
    });
  });
  it.each([
    { action: "channel-info", params: {}, includeMembers: false },
    { action: "member-info", params: {}, includeMembers: true },
    { action: "channel-info", params: { includeMembers: true }, includeMembers: true },
    { action: "channel-info", params: { members: true }, includeMembers: true },
  ] as const)("reads $action with $params", async ({ action, params, includeMembers }) => {
    const channel = { chat_id: "oc_group_1", name: "Eng", chat_mode: "group" };
    const page = {
      chat_id: "oc_group_1",
      members: [{ member_id: "ou_1", name: "Alice" }],
      has_more: false,
    };
    getChatInfoMock.mockResolvedValueOnce(channel);
    getChatMembersMock.mockResolvedValueOnce(page);
    const result = details(
      await run(action, { chatId: "oc_group_1", pageSize: "0x10", ...params }),
    );
    expect(result).toMatchObject(
      action === "channel-info"
        ? {
            ok: true,
            provider: "feishu",
            action,
            channel,
            ...(includeMembers ? { members: page } : {}),
          }
        : { ok: true, channel: "feishu", action, ...page },
    );
    expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_group_1");
    if (includeMembers) {
      expect(getChatMembersMock).toHaveBeenCalledExactlyOnceWith(
        { tag: "client" },
        "oc_group_1",
        undefined,
        undefined,
        "open_id",
      );
    }
  });

  it.each([
    [{ memberId: "ou_1" }, "ou_1", "open_id"],
    [{ userId: "u_1" }, "u_1", "user_id"],
    [{ userId: "u_1", memberIdType: "open_id" }, "u_1", "open_id"],
  ] as const)(
    "checks group membership using the requested identifier type: %j",
    async (params, id, type) => {
      getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: id, name: "Alice" });
      expect(details(await run("member-info", { chatId: "oc_group_1", ...params }))).toMatchObject({
        ok: true,
        member: { member_id: id, name: "Alice" },
      });
      expect(assertFeishuChatMemberMock).toHaveBeenCalledExactlyOnceWith(
        { tag: "client" },
        "oc_group_1",
        id,
        type,
      );
      expect(getFeishuMemberInfoMock).toHaveBeenCalledExactlyOnceWith({ tag: "client" }, id, type);
    },
  );
  it.each([
    { sender: "ou_sender", type: "open_id", requested: "ou_sender" },
    { sender: "u_mobile_only", type: "user_id", requested: "u_mobile_only" },
    { sender: "ou_sender", type: "open_id", requested: "ou_other" },
  ])(
    "limits direct-chat member $requested to the trusted sender $sender",
    async ({ sender, type, requested }) => {
      getChatInfoMock.mockResolvedValueOnce({
        chat_id: "oc_direct",
        chat_mode: "p2p",
        chat_type: "private",
      });
      const member = { member_id: sender, member_id_type: type };
      getFeishuMemberInfoMock.mockResolvedValueOnce(member);
      const result = run(
        "member-info",
        { memberId: requested, chatId: "oc_direct" },
        {
          requesterAccountId: "default",
          requesterSenderId: sender,
          toolContext: { currentChannelProvider: "feishu", currentChannelId: "oc_direct" },
        },
      );
      if (requested !== sender) {
        await expect(result).rejects.toThrow("limited to the current sender");
        expect(getFeishuMemberInfoMock).not.toHaveBeenCalled();
      } else {
        expect(details(await result)).toMatchObject({ ok: true, member });
        expect(assertFeishuChatMemberMock).not.toHaveBeenCalled();
        expect(getFeishuMemberInfoMock).toHaveBeenCalledExactlyOnceWith(
          { tag: "client" },
          sender,
          type,
        );
      }
    },
  );
  it.each(["success", "failure"] as const)("preserves live directory %s", async (outcome) => {
    const success = outcome === "success";
    const groups = [{ kind: "group", id: "oc_group_1" }];
    const peers = [{ kind: "user", id: "ou_1" }];
    if (success) {
      listFeishuDirectoryGroupsLiveMock.mockResolvedValueOnce(groups);
    } else {
      listFeishuDirectoryGroupsLiveMock.mockRejectedValueOnce(new Error("token expired"));
    }
    listFeishuDirectoryPeersLiveMock.mockResolvedValueOnce(peers);
    const result = run("channel-list", {
      query: "eng",
      limit: success ? "+05" : "-1",
      ...(success ? {} : { scope: "groups" }),
    });
    if (success) {
      expect(details(await result)).toMatchObject({ ok: true, groups, peers });
    } else {
      await expect(result).rejects.toThrow("token expired");
    }
    const expected = {
      ...actionContext,
      query: "eng",
      limit: success ? 5 : undefined,
      fallbackToStatic: false,
    };
    expect(listFeishuDirectoryGroupsLiveMock).toHaveBeenCalledExactlyOnceWith({
      ...expected,
      filter: expect.any(Function),
    });
    if (success) {
      expect(listFeishuDirectoryPeersLiveMock).toHaveBeenCalledExactlyOnceWith(expected);
    } else {
      expect(listFeishuDirectoryPeersLiveMock).not.toHaveBeenCalled();
    }
  });
  it.each(["read", "channel-info"] as const)("blocks %s before provider access", async (action) => {
    await expect(
      run(action, { messageId: "om_blocked", chatId: "oc_blocked" }, { cfg: blockedCfg }),
    ).rejects.toThrow("Feishu read target is not allowed.");
    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(getChatInfoMock).not.toHaveBeenCalled();
    expect(getMessageFeishuMock).not.toHaveBeenCalled();
  });
  it("rejects messages returned from a different chat than the authorized target", async () => {
    getMessageFeishuMock.mockResolvedValueOnce(fetched("oc_other"));
    await expect(
      run("reactions", { messageId: "om_1", chatId: "oc_allowed" }, { cfg: blockedCfg }),
    ).rejects.toThrow("Feishu message target is not allowed.");
    expect(getMessageFeishuMock).toHaveBeenCalledOnce();
    expect(listReactionsFeishuMock).not.toHaveBeenCalled();
  });
  it.each(["ambiguous", "allowed"] as const)(
    "handles metadata failures for %s targets",
    async (access) => {
      const error = new Error("provider unavailable");
      getChatInfoMock.mockRejectedValueOnce(error);
      const result = run(
        access === "ambiguous" ? "read" : "channel-info",
        { messageId: "om_unknown", chatId: "oc_unknown" },
        access === "ambiguous" ? { cfg: policyCfg } : {},
      );
      if (access === "ambiguous") {
        await expect(result).rejects.toThrow("Feishu read target is not allowed.");
        for (const reader of [
          getMessageFeishuMock,
          listPinsFeishuMock,
          getChatMembersMock,
          assertFeishuChatMemberMock,
          getFeishuMemberInfoMock,
        ]) {
          expect(reader).not.toHaveBeenCalled();
        }
      } else {
        await expect(result).rejects.toBe(error);
        expect(createFeishuClientMock).toHaveBeenCalledOnce();
      }
      expect(getChatInfoMock).toHaveBeenCalledOnce();
    },
  );
});

describe("Feishu reactions", () => {
  it("requires an explicit clearAll before removing bot reactions", async () => {
    await expect(run("react", { messageId: "om_1" })).rejects.toThrow("Set clearAll=true");
    expect(removeReactionFeishuMock).not.toHaveBeenCalled();
  });
  it("adds a reaction to an authorized direct-operator target", async () => {
    getMessageFeishuMock.mockResolvedValueOnce(fetched());
    expect(
      details(await run("react", { messageId: "om_1", emoji: "THUMBSUP" }, directOperatorContext)),
    ).toMatchObject({ ok: true, added: "THUMBSUP" });
    expect(addReactionFeishuMock).toHaveBeenCalledExactlyOnceWith({
      ...actionContext,
      messageId: "om_1",
      emojiType: "THUMBSUP",
    });
  });
  it("resolves unknown chat type before clearing only this bot's reactions", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_1",
      chatId: "oc_group_1",
      content: "hello",
      contentType: "text",
    });
    listReactionsFeishuMock.mockResolvedValueOnce([
      { reactionId: "r1", operatorType: "app", operatorId: "cli_main" },
      { reactionId: "r2", operatorType: "app", operatorId: "cli_main" },
      { reactionId: "r-other", operatorType: "app", operatorId: "cli_other" },
      { reactionId: "r-user", operatorType: "user", operatorId: "ou_user" },
    ]);
    expect(
      details(
        await run(
          "react",
          { messageId: "om_1", clearAll: true },
          { ...currentReadContext, cfg: policyCfg },
        ),
      ),
    ).toMatchObject({ ok: true, removed: 2 });
    expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_group_1");
    expect(removeReactionFeishuMock).toHaveBeenCalledTimes(2);
    expect(removeReactionFeishuMock).toHaveBeenNthCalledWith(1, {
      cfg: policyCfg,
      accountId: "default",
      messageId: "om_1",
      reactionId: "r1",
    });
    expect(removeReactionFeishuMock).toHaveBeenNthCalledWith(2, {
      cfg: policyCfg,
      accountId: "default",
      messageId: "om_1",
      reactionId: "r2",
    });
  });
  it.each([true, false])(
    "removes a matching reaction only if owned by this bot: %j",
    async (own) => {
      getMessageFeishuMock.mockResolvedValueOnce(fetched());
      listReactionsFeishuMock.mockResolvedValueOnce([
        { reactionId: "r-other", operatorType: "app", operatorId: "cli_other" },
        {
          reactionId: "r1",
          operatorType: own ? "app" : "user",
          operatorId: own ? "cli_main" : "ou_user",
        },
      ]);
      expect(
        details(
          await run("react", {
            messageId: "om_1",
            chatId: "oc_group_1",
            emoji: "THUMBSUP",
            remove: true,
          }),
        ),
      ).toMatchObject({ ok: true, removed: own ? "THUMBSUP" : null });
      if (own) {
        expect(removeReactionFeishuMock).toHaveBeenCalledExactlyOnceWith({
          ...actionContext,
          messageId: "om_1",
          reactionId: "r1",
        });
      } else {
        expect(removeReactionFeishuMock).not.toHaveBeenCalled();
      }
    },
  );
  it("lists reactions after message authorization", async () => {
    const reactions = [{ reactionId: "r1", operatorType: "app", operatorId: "cli_main" }];
    getMessageFeishuMock.mockResolvedValueOnce(fetched());
    listReactionsFeishuMock.mockResolvedValueOnce(reactions);
    expect(
      details(await run("reactions", { messageId: "om_1", chatId: "oc_group_1" })),
    ).toMatchObject({ ok: true, reactions });
    expect(listReactionsFeishuMock).toHaveBeenCalledExactlyOnceWith({
      ...actionContext,
      messageId: "om_1",
    });
  });
});

describe("Feishu topic routing", () => {
  it.each(["implicit", "explicit"] as const)(
    "preserves prepared %s reply semantics",
    async (source) => {
      textDelivery();
      await run(
        "send",
        { to: "chat:oc_group_1", text: "reply", replyTo: "om_inbound" },
        {
          ...topicContext,
          sessionKey: "feishu:group:oc_group_1:topic:om_inbound:sender:ou_user",
          reply:
            source === "explicit"
              ? { source, replyToId: "om_inbound" }
              : { source, replyToId: "om_inbound", mode: "all" },
        },
      );
      expect(feishuOutboundSendTextMock).toHaveBeenCalledExactlyOnceWith({
        ...actionContext,
        to: "chat:oc_group_1",
        text: "reply",
        mediaLocalRoots: undefined,
        ...(source === "implicit" ? { threadId: "om_inbound" } : { replyToId: "om_inbound" }),
      });
    },
  );
  it.each([
    { name: "destination changes", params: { to: "chat:oc_other" }, context: topicContext },
    { name: "top-level requested", params: { topLevel: true }, context: topicContext },
    { name: "inheritance suppressed", params: { threadId: null }, context: topicContext },
    { name: "account changes", context: { ...topicContext, requesterAccountId: "other" } },
    {
      name: "session has no topic",
      context: { ...topicContext, sessionKey: "feishu:group:oc_group_1" },
    },
    { name: "inbound context is absent", context: { ...topicContext, toolContext: {} } },
  ] satisfies Array<{ name: string; params?: Record<string, unknown>; context: Context }>)(
    "does not inherit a source topic when $name",
    async ({ params, context }) => {
      textDelivery();
      const target = { to: "chat:oc_group_1", ...params };
      await run("send", { ...target, text: "hello" }, context);
      expect(feishuOutboundSendTextMock).toHaveBeenCalledExactlyOnceWith({
        ...actionContext,
        to: target.to,
        text: "hello",
        mediaLocalRoots: undefined,
        replyToId: undefined,
      });
    },
  );
  it("requires a thread-reply anchor", async () => {
    await expect(run("thread-reply", { to: "chat:oc_group_1", message: "reply" })).rejects.toThrow(
      "Feishu thread-reply requires messageId.",
    );
  });
  it("rejects unsupported actions", async () => {
    await expect(run("search", {})).rejects.toThrow('Unsupported Feishu action: "search"');
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
