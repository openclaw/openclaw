import type { webhook } from "@line/bot-sdk";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLineRuntime } from "./runtime.js";
import type { LineAccountConfig } from "./types.js";
import { createTestMessageEvent } from "./webhook-spool.test-support.js";

type MessageEvent = webhook.MessageEvent;

const pairingDeliveryMocks = vi.hoisted(() => ({
  invokePairingReply: false,
  pushMessageLine: vi.fn<
    (...args: Parameters<typeof import("./send.js").pushMessageLine>) => Promise<void>
  >(async () => {
    throw new Error("pushMessageLine should not be called from bot-handlers tests");
  }),
  replyMessageLine: vi.fn<
    (...args: Parameters<typeof import("./send.js").replyMessageLine>) => Promise<void>
  >(async () => {
    throw new Error("replyMessageLine should not be called from bot-handlers tests");
  }),
}));

// Stub delivery and context wiring while keeping mention-drop diagnostics real.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  implicitMentionKindWhen: (await import("openclaw/plugin-sdk/channel-mention-gating"))
    .implicitMentionKindWhen,
  logInboundDrop: (await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>())
    .logInboundDrop,
  buildMentionRegexes: () => [],
  isChannelPartialDeliveryError: (error: unknown) =>
    Boolean(
      error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "CHANNEL_PARTIAL_DELIVERY",
    ),
  matchesMentionPatterns: () => false,
}));
vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingChallengeIssuer:
    ({ upsertPairingRequest }: { upsertPairingRequest: (args: unknown) => Promise<unknown> }) =>
    async ({
      senderId,
      onCreated,
      sendPairingReply,
    }: {
      senderId: string;
      onCreated?: () => void;
      sendPairingReply?: (text: string) => Promise<void>;
    }) => {
      await upsertPairingRequest({ id: senderId, meta: {} });
      onCreated?.();
      if (pairingDeliveryMocks.invokePairingReply) {
        await sendPairingReply?.("Pairing challenge");
      }
    },
}));
vi.mock("openclaw/plugin-sdk/command-auth-native", () => ({
  hasControlCommand: (text: string) => {
    const body = text.trim().toLowerCase();
    return body === "/status" || body.startsWith("/status ");
  },
  resolveControlCommandGate: ({
    hasControlCommand,
    authorizers,
  }: {
    hasControlCommand: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => ({
    commandAuthorized:
      hasControlCommand && authorizers.some((entry) => entry.allowed || !entry.configured),
  }),
}));
vi.mock("openclaw/plugin-sdk/runtime-group-policy", () => ({
  resolveAllowlistProviderRuntimeGroupPolicy: ({
    groupPolicy,
    defaultGroupPolicy,
  }: {
    groupPolicy?: string;
    defaultGroupPolicy: string;
  }) => ({
    groupPolicy: groupPolicy ?? defaultGroupPolicy,
    providerMissingFallbackApplied: false,
  }),
  resolveDefaultGroupPolicy: (cfg: { channels?: { line?: { groupPolicy?: string } } }) =>
    cfg.channels?.line?.groupPolicy ?? "open",
  warnMissingProviderGroupPolicyFallbackOnce: () => {},
}));
const logVerboseMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  danger: (text: string) => text,
  logVerbose: logVerboseMock,
}));
vi.mock("openclaw/plugin-sdk/reply-history", () => ({
  DEFAULT_GROUP_HISTORY_LIMIT: 20,
  createChannelHistoryWindow: ({ historyMap }: { historyMap: Map<string, HistoryEntry[]> }) => ({
    record: ({
      historyKey,
      limit,
      entry,
    }: {
      historyKey: string;
      limit: number;
      entry: HistoryEntry;
    }) => {
      const existing = historyMap.get(historyKey) ?? [];
      historyMap.set(historyKey, [...existing, entry].slice(-limit));
    },
    buildInboundHistory: ({ historyKey, limit }: { historyKey: string; limit: number }) => {
      if (limit <= 0) {
        return undefined;
      }
      return (historyMap.get(historyKey) ?? []).slice(-limit);
    },
  }),
}));
const { readAllowFromStoreMock, upsertPairingRequestMock } = vi.hoisted(() => ({
  readAllowFromStoreMock: vi.fn(async () => [] as string[]),
  upsertPairingRequestMock: vi.fn(async (_args: unknown) => ({ code: "CODE", created: true })),
}));
const downloadLineMediaMock = vi.hoisted(() => vi.fn());
const getUserDisplayNameMock = vi.hoisted(() => vi.fn(async (userId: string) => userId));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  resolvePairingIdLabel: () => "lineUserId",
  readChannelAllowFromStore: readAllowFromStoreMock,
  upsertChannelPairingRequest: upsertPairingRequestMock,
}));

vi.mock("./download.js", async (importActual) => ({
  ...(await importActual<typeof import("./download.js")>()),
  downloadLineMedia: downloadLineMediaMock,
}));

vi.mock("./send.js", () => ({
  getLineGroupName: vi.fn(),
  getUserDisplayName: getUserDisplayNameMock,
  pushMessageLine: pairingDeliveryMocks.pushMessageLine,
  replyMessageLine: pairingDeliveryMocks.replyMessageLine,
}));

const {
  buildLineMessageContextMock,
  buildLinePostbackContextMock,
  resolveLineQuestionPostbackMock,
} = vi.hoisted(() => ({
  buildLineMessageContextMock: vi.fn(
    async (_params: {
      allMedia?: { path: string }[];
      // The event the turn answers as: its reply token is what reaches LINE.
      event?: { replyToken?: string };
    }) => ({
      ctxPayload: { From: "line:group:group-1" },
      replyToken: "reply-token",
      route: { agentId: "default" },
      isGroup: true,
      accountId: "default",
    }),
  ),
  buildLinePostbackContextMock: vi.fn(async () => null as unknown),
  resolveLineQuestionPostbackMock: vi.fn<
    typeof import("./question-postback.js").resolveLineQuestionPostback
  >(async () => ({ status: "answered" as const })),
}));

vi.mock("./question-postback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./question-postback.js")>()),
  resolveLineQuestionPostback: resolveLineQuestionPostbackMock,
}));

vi.mock("./bot-message-context.js", async (importOriginal) => ({
  // Keep text parsing real; stub context construction only.
  ...(await importOriginal<typeof import("./bot-message-context.js")>()),
  buildLineMessageContext: buildLineMessageContextMock,
  buildLinePostbackContext: buildLinePostbackContextMock,
  prepareLineInboundRoute: async () => ({ mentionAgentId: "default" }),
}));

// Cold module transforms belong to collection, not a timed lifecycle hook.
const { handleLineWebhookEvents } = await import("./bot-handlers.js");
type LineWebhookContext = Parameters<typeof import("./bot-handlers.js").handleLineWebhookEvents>[1];

function postbackEvent(
  webhookEventId: string,
  data: string,
  source: webhook.Source = { type: "user", userId: "user-one" },
): webhook.PostbackEvent {
  return {
    type: "postback",
    replyToken: "reply-token",
    timestamp: Date.now(),
    source,
    mode: "active",
    webhookEventId,
    deliveryContext: { isRedelivery: false },
    postback: { data },
  };
}

function imageEvent(id: string, userId: string): MessageEvent {
  return createTestMessageEvent({
    message: { id, type: "image", contentProvider: { type: "line" }, quoteToken: "quote-token" },
    source: { type: "user", userId },
    webhookEventId: `evt-${id}`,
  });
}

function textEvent(
  id: string,
  userId: string,
  webhookEventId: string,
  text = "hello",
): MessageEvent {
  return createTestMessageEvent({
    message: { id, type: "text", text, quoteToken: `${id}-quote` },
    source: { type: "user", userId },
    webhookEventId,
  });
}

const questionUser = "U0123456789abcdef0123456789abcdef";
function questionEvent(
  id: string,
  option = "1",
  source: webhook.Source = { type: "user", userId: "user-one" },
) {
  return postbackEvent(
    id,
    `line.question=ask_3d8dbe55be452a9a39add7c909beb119&line.option=${option}`,
    source,
  );
}

function expectHistory(inboundHistory: unknown[], call?: number) {
  const expected = expect.objectContaining({ inboundHistory });
  if (call === undefined) {
    expect(buildLineMessageContextMock).toHaveBeenCalledWith(expected);
  } else {
    expect(buildLineMessageContextMock).toHaveBeenNthCalledWith(call, expected);
  }
}

function noticeEvent(id: string) {
  return postbackEvent(id, "line.question=ask_0123456789abcdef0123456789abcdef&line.option=1", {
    type: "user",
    userId: questionUser,
  });
}

function imageSetPart(messageId: string, timestamp: number, index?: number) {
  return createTestMessageEvent({
    message: {
      id: messageId,
      type: "image",
      contentProvider: { type: "line" },
      imageSet:
        index === undefined
          ? { id: "image-set-unindexed" }
          : { id: "image-set-fresh", index, total: 3 },
    } as MessageEvent["message"],
    source: { type: "user", userId: "U1" },
    webhookEventId: `evt-${index ?? messageId}`,
    replyToken: `reply-${index ?? messageId}`,
    timestamp,
  });
}

function mockImageDownloads() {
  downloadLineMediaMock.mockImplementation(async (messageId: string) => ({
    path: `/media/${messageId}.png`,
    contentType: "image/png",
    size: 10,
  }));
}

function createHistoryEvent(
  groupId: string,
  userId: string,
  id: string,
  text: string,
  timestamp: number,
  mentioned = false,
): MessageEvent {
  return createTestMessageEvent({
    message: {
      id,
      type: "text",
      text,
      quoteToken: "test-token-placeholder",
      ...(mentioned
        ? {
            mention: { mentionees: [{ index: 0, length: 4, type: "user" as const, isSelf: true }] },
          }
        : {}),
    },
    source: { type: "group", groupId, userId },
    webhookEventId: id.replace(/^m-/, "evt-"),
    timestamp,
  });
}

function createHarness(
  params: {
    processMessage?: LineWebhookContext["processMessage"];
    groupPolicy?: LineAccountConfig["groupPolicy"];
    dmPolicy?: LineAccountConfig["dmPolicy"];
    allowFrom?: LineAccountConfig["allowFrom"];
    groupAllowFrom?: LineAccountConfig["groupAllowFrom"];
    requireMention?: boolean;
    groupHistories?: Map<string, HistoryEntry[]>;
    turnAdoptionLifecycle?: LineWebhookContext["turnAdoptionLifecycle"];
  } = {},
) {
  const processMessage = vi.fn(params.processMessage);
  const allowFrom = params.allowFrom ?? (params.dmPolicy === "open" ? ["*"] : undefined);
  const lineConfig = {
    ...(params.groupPolicy ? { groupPolicy: params.groupPolicy } : {}),
    ...(params.dmPolicy ? { dmPolicy: params.dmPolicy } : {}),
    ...(allowFrom ? { allowFrom } : {}),
    ...(params.groupAllowFrom ? { groupAllowFrom: params.groupAllowFrom } : {}),
  };
  const context: LineWebhookContext = {
    cfg: { channels: { line: lineConfig } },
    account: {
      accountId: "default",
      enabled: true,
      channelAccessToken: "token",
      channelSecret: "secret",
      tokenSource: "config",
      config: {
        ...lineConfig,
        ...(params.requireMention === undefined
          ? {}
          : { groups: { "*": { requireMention: params.requireMention } } }),
      },
    },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    mediaMaxBytes: 1,
    processMessage,
    ...(params.groupHistories ? { groupHistories: params.groupHistories } : {}),
    ...(params.turnAdoptionLifecycle
      ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
      : {}),
  };
  return {
    processMessage,
    context,
    receive: (...events: webhook.Event[]) => handleLineWebhookEvents(events, context),
  };
}

function createTurnAdoptionLifecycleSpy() {
  return {
    admission: "exclusive" as const,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(() => {}),
    onAbandoned: vi.fn(async () => {}),
    abortSignal: new AbortController().signal,
  };
}

function createHistoryHarness(groupId: string, process?: LineWebhookContext["processMessage"]) {
  const groupHistories = new Map<string, HistoryEntry[]>();
  const harness = createHarness({
    groupPolicy: "open",
    requireMention: true,
    groupHistories,
    processMessage: process,
  });
  return {
    ...harness,
    groupHistories,
    send: (user: string, id: string, text: string, time: number, mentioned = false) =>
      harness.receive(createHistoryEvent(groupId, user, id, text, time, mentioned)),
  };
}

describe("handleLineWebhookEvents", () => {
  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/channel-inbound");
    vi.doUnmock("openclaw/plugin-sdk/channel-pairing");
    vi.doUnmock("openclaw/plugin-sdk/command-auth-native");
    vi.doUnmock("openclaw/plugin-sdk/runtime-group-policy");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/reply-history");
    vi.doUnmock("openclaw/plugin-sdk/conversation-runtime");
    vi.doUnmock("./download.js");
    vi.doUnmock("./send.js");
    vi.doUnmock("./bot-message-context.js");
    vi.resetModules();
  });

  beforeEach(() => {
    logVerboseMock.mockClear();
    setLineRuntime(createPluginRuntimeMock());
    pairingDeliveryMocks.invokePairingReply = false;
    pairingDeliveryMocks.pushMessageLine.mockReset().mockImplementation(async () => {
      throw new Error("pushMessageLine should not be called from bot-handlers tests");
    });
    pairingDeliveryMocks.replyMessageLine.mockReset().mockImplementation(async () => {
      throw new Error("replyMessageLine should not be called from bot-handlers tests");
    });
    buildLineMessageContextMock.mockReset().mockImplementation(async () => ({
      ctxPayload: { From: "line:group:group-1" },
      replyToken: "reply-token",
      route: { agentId: "default" },
      isGroup: true,
      accountId: "default",
    }));
    buildLinePostbackContextMock.mockReset().mockImplementation(async () => null as unknown);
    readAllowFromStoreMock.mockReset().mockImplementation(async () => [] as string[]);
    upsertPairingRequestMock
      .mockReset()
      .mockImplementation(async () => ({ code: "CODE", created: true }));
    downloadLineMediaMock.mockReset().mockImplementation(async () => {
      throw new Error("downloadLineMedia should not be called from bot-handlers tests");
    });
    getUserDisplayNameMock.mockReset().mockImplementation(async (userId: string) => userId);
  });
  it.each([
    ["inline slash token cannot bypass mention gating", "cd /home", "allowlist", ["user-cmd"]],
    ["open-group permission cannot authorize a control command", "/status", "open", undefined],
  ] as const)("%s", async (_label, text, groupPolicy, groupAllowFrom) => {
    const { receive, processMessage } = createHarness({
      groupPolicy,
      groupAllowFrom: groupAllowFrom && [...groupAllowFrom],
      requireMention: true,
    });
    await receive(createHistoryEvent("group-1", "user-cmd", "m-gate", text, 1000));
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("does not use the DM allowlist when group allowlist policy has no group entries", async () => {
    const { receive, processMessage } = createHarness({
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "allowlist",
      requireMention: false,
    });
    await receive(createHistoryEvent("group-1", "user-open-dm", "m5c", "hello", 1000));
    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("falls back to push when the pairing reply was not delivered", async () => {
    pairingDeliveryMocks.invokePairingReply = true;
    pairingDeliveryMocks.replyMessageLine.mockRejectedValueOnce(
      new Error("provider delivery rejected"),
    );
    await createHarness({ dmPolicy: "pairing" }).receive(
      textEvent("pairing-final", "pairing-user", "pairing-final-event"),
    );

    expect(pairingDeliveryMocks.replyMessageLine).toHaveBeenCalledOnce();
    expect(pairingDeliveryMocks.pushMessageLine).toHaveBeenCalledTimes(1);
  });

  it("does not authorize DM senders from another account's pairing-store entries", async () => {
    const { receive, processMessage, context } = createHarness({ dmPolicy: "pairing" });
    readAllowFromStoreMock.mockImplementation(async (...args: unknown[]) => {
      const accountId = args[2] as string | undefined;
      if (accountId === "work") {
        return [];
      }
      return ["cross-account-user"];
    });
    upsertPairingRequestMock.mockResolvedValue({ code: "CODE", created: false });

    Object.assign(context.account, {
      accountId: "work",
      channelAccessToken: "token-work",
      channelSecret: "secret-work",
    });
    await receive(textEvent("m6", "cross-account-user", "evt-6", "hi"));

    expect(readAllowFromStoreMock).toHaveBeenCalledWith("line", undefined, "work");
    expect(processMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock.mock.calls[0]?.[0]).toMatchObject({
      channel: "line",
      id: "cross-account-user",
      accountId: "work",
    });
  });

  it("keeps matching display names distinct in pending group history", async () => {
    const { receive, send, processMessage, groupHistories } = createHistoryHarness("group-hist-1");
    getUserDisplayNameMock.mockResolvedValue("Sora");

    // One delivery is one turn, so the two sends arrive as two deliveries.
    await receive(
      createTestMessageEvent({
        message: {
          id: "m-hist-1",
          type: "text",
          text: "() (hello)",
          quoteToken: "q-hist-1",
          emojis: [
            { index: 0, length: 2, productId: "emoji-set", emojiId: "1" },
            { index: 3, length: 7, productId: "emoji-set", emojiId: "2" },
          ],
        },
        timestamp: 1700000000000,
        source: { type: "group", groupId: "group-hist-1", userId: "user-one" },
        webhookEventId: "evt-hist-1",
      }),
    );
    await send("user-two", "m-hist-2", "second", 1700000001000);

    expect(processMessage).not.toHaveBeenCalled();
    const history = [
      expect.objectContaining({ sender: "Sora (user-one)", body: "[emoji] (hello)" }),
      expect.objectContaining({ sender: "Sora (user-two)", body: "second" }),
    ];
    expect(groupHistories.get("group-hist-1")).toEqual(history);

    await send("user-three", "m-hist-mention", "@Bot summarize", 1700000002000, true);

    expectHistory(history);
  });

  it("consumes malformed question callbacks without starting an agent turn", async () => {
    resolveLineQuestionPostbackMock.mockClear();
    const { receive, processMessage } = createHarness({ dmPolicy: "open" });
    await receive(questionEvent("evt-question-malformed", "9007199254740992"));

    expect(resolveLineQuestionPostbackMock).not.toHaveBeenCalled();
    expect(buildLinePostbackContextMock).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("does not resolve allowlisted group question taps without a user ID", async () => {
    resolveLineQuestionPostbackMock.mockClear();
    const { receive, processMessage } = createHarness({
      groupPolicy: "allowlist",
      groupAllowFrom: ["user-allowed"],
    });
    await receive(
      questionEvent("evt-question-denied-allowlist", "1", { type: "group", groupId: "group-1" }),
    );

    expect(resolveLineQuestionPostbackMock).not.toHaveBeenCalled();
    expect(buildLinePostbackContextMock).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("rechecks paired access without another pairing challenge or answer notice", async () => {
    const { receive, processMessage } = createHarness({ dmPolicy: "pairing" });
    readAllowFromStoreMock.mockResolvedValue([questionUser]);
    let admittedBeforeWrite = true;
    resolveLineQuestionPostbackMock.mockImplementationOnce(async ({ authorize }) => {
      // The Gateway can await its question read while this pairing is revoked.
      readAllowFromStoreMock.mockResolvedValue([]);
      admittedBeforeWrite = await authorize();
      return { status: admittedBeforeWrite ? "answered" : "denied" };
    });
    await receive(
      questionEvent("evt-question-revoked", "1", { type: "user", userId: questionUser }),
    );

    expect(readAllowFromStoreMock).toHaveBeenCalledTimes(2);
    expect(admittedBeforeWrite).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(pairingDeliveryMocks.replyMessageLine).not.toHaveBeenCalled();
    expect(pairingDeliveryMocks.pushMessageLine).not.toHaveBeenCalled();
    expect(buildLinePostbackContextMock).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rechecks failed notice admission for revoked=%s over reply",
    async (revoked) => {
      const { receive, processMessage } = createHarness({ dmPolicy: "pairing" });
      readAllowFromStoreMock.mockResolvedValue([questionUser]);
      resolveLineQuestionPostbackMock.mockImplementationOnce(async () => {
        if (revoked) {
          readAllowFromStoreMock.mockResolvedValue([]);
        }
        return { status: "failed" };
      });
      pairingDeliveryMocks.replyMessageLine.mockResolvedValueOnce(undefined);
      pairingDeliveryMocks.pushMessageLine.mockResolvedValueOnce(undefined);
      await receive(noticeEvent(`notice-failed-${revoked}-reply`));
      expect(pairingDeliveryMocks.replyMessageLine).toHaveBeenCalledTimes(revoked ? 0 : 1);
      expect(pairingDeliveryMocks.pushMessageLine).not.toHaveBeenCalled();
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(processMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    { revoked: false, partial: false, pushed: true },
    { revoked: true, partial: false, pushed: false },
    { revoked: false, partial: true, pushed: false },
  ])(
    "rechecks notice fallback after reply failure revoked=$revoked partial=$partial",
    async ({ revoked, partial, pushed }) => {
      const { receive, processMessage } = createHarness({ dmPolicy: "pairing" });
      readAllowFromStoreMock.mockResolvedValue([questionUser]);
      resolveLineQuestionPostbackMock.mockResolvedValueOnce({ status: "already-terminal" });
      pairingDeliveryMocks.replyMessageLine.mockImplementationOnce(async () => {
        if (revoked) {
          readAllowFromStoreMock.mockResolvedValue([]);
        }
        throw Object.assign(
          new Error("reply failed"),
          partial ? { code: "CHANNEL_PARTIAL_DELIVERY" } : {},
        );
      });
      pairingDeliveryMocks.pushMessageLine.mockResolvedValueOnce(undefined);
      await receive(noticeEvent(`notice-fallback-${revoked}-${partial}`));
      expect(pairingDeliveryMocks.replyMessageLine).toHaveBeenCalledOnce();
      expect(pairingDeliveryMocks.pushMessageLine).toHaveBeenCalledTimes(pushed ? 1 : 0);
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(processMessage).not.toHaveBeenCalled();
    },
  );

  it("routes an ordinary postback without logging its content", async () => {
    resolveLineQuestionPostbackMock.mockClear();
    const { receive } = createHarness({ dmPolicy: "open" });
    await receive(postbackEvent("evt-plain-postback", "line.action=play&line.device=tv"));

    expect(resolveLineQuestionPostbackMock).not.toHaveBeenCalled();
    expect(buildLinePostbackContextMock).toHaveBeenCalled();
    expect(logVerboseMock.mock.calls.join(",")).not.toContain("line.action=play&line.device=tv");
  });

  it("keeps a group message recorded during a mention turn instead of clearing it", async () => {
    const gate = Promise.withResolvers<void>();
    const { send, processMessage, groupHistories } = createHistoryHarness(
      "grp-race",
      () => gate.promise,
    );

    await send("user-b", "m-past", "earlier chatter", 1000);
    expect(groupHistories.get("grp-race")).toHaveLength(1);

    // A mention turn starts and parks in processMessage (agent still running).
    const mentionRun = send("user-a", "m-mention", "@Bot summarize", 2000, true);
    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledTimes(1));

    await send("user-c", "m-concurrent", "ping", 3000);
    expect(groupHistories.get("grp-race")).toHaveLength(2);

    gate.resolve();
    await mentionRun;

    expectHistory([expect.objectContaining({ body: "earlier chatter" })]);
    expect(groupHistories.get("grp-race")).toEqual([expect.objectContaining({ body: "ping" })]);
  });

  it("keeps a message arriving between the history snapshot and context construction for the next mention", async () => {
    const contextGate = Promise.withResolvers<void>();
    const { send, groupHistories } = createHistoryHarness("grp-mid");

    await send("user-b", "m-past", "earlier chatter", 1000);

    // The mention turn parks inside buildLineMessageContext: the handler has
    // snapshotted the window, but the turn context does not exist yet.
    buildLineMessageContextMock.mockImplementationOnce(async () => {
      await contextGate.promise;
      return {
        ctxPayload: { From: "line:group:grp-mid" },
        replyToken: "test-auth-token",
        route: { agentId: "default" },
        isGroup: true,
        accountId: "default",
      };
    });
    const mentionRun = send("user-a", "m-mention", "@Bot summarize", 2000, true);
    await vi.waitFor(() => expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1));

    await send("user-c", "m-mid", "ping", 3000);

    expectHistory([expect.objectContaining({ body: "earlier chatter" })], 1);

    contextGate.resolve();
    await mentionRun;

    expect(groupHistories.get("grp-mid")).toEqual([expect.objectContaining({ body: "ping" })]);

    await send("user-a", "m-mention-2", "@Bot again", 4000, true);
    expectHistory([expect.objectContaining({ body: "ping" })], 2);
    expect(groupHistories.has("grp-mid")).toBe(false);
  });

  it("keeps group history intact when a mention turn fails, so the retry still has context", async () => {
    const { send, processMessage, groupHistories } = createHistoryHarness("grp-fail", async () => {
      throw new Error("agent failure");
    });

    await send("user-b", "m-ambient", "context", 1000);
    expect(groupHistories.get("grp-fail")).toHaveLength(1);

    await expect(send("user-a", "m-mention-fail", "@Bot help", 2000, true)).rejects.toThrow(
      /agent failure/,
    );

    // Failed turns must leave the consumed window available for retry.
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(groupHistories.get("grp-fail")).toHaveLength(1);
  });

  it("forwards LINE file names to media downloads and to the message context", async () => {
    const { receive, processMessage } = createHarness({ dmPolicy: "open" });
    downloadLineMediaMock.mockResolvedValueOnce({
      path: "/tmp/line-media/voice-note.m4a",
      contentType: "audio/x-m4a",
      size: 1234,
    });
    const event = createTestMessageEvent({
      message: {
        id: "file-audio-1",
        type: "file",
        fileName: "voice-note.m4a",
        fileSize: 4096,
      } as MessageEvent["message"],
      source: { type: "user", userId: "user-file-audio" },
      webhookEventId: "evt-file-audio",
    });

    await receive(event);

    expect(downloadLineMediaMock).toHaveBeenCalledWith("file-audio-1", "token", 1, {
      originalFilename: "voice-note.m4a",
    });
    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allMedia: [
          {
            path: "/tmp/line-media/voice-note.m4a",
            contentType: "audio/x-m4a",
            fileName: "voice-note.m4a",
          },
        ],
      }),
    );
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("reports failed media materialization to the message-context owner", async () => {
    downloadLineMediaMock.mockRejectedValueOnce(new Error("expired content"));
    const { receive, processMessage } = createHarness({ dmPolicy: "open" });
    const event = imageEvent("image-failed-1", "user-image-failed");

    await receive(event);

    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ allMedia: [], mediaUnavailable: true }),
    );
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects the event for retry instead of degrading when preparation media fails transiently", async () => {
    // Pre-adoption 202 failures must reach the spool for retry, not lose the attachment.
    downloadLineMediaMock.mockRejectedValueOnce(
      new MediaFetchError("http_error", "still preparing (HTTP 202)", { status: 202 }),
    );
    const { receive, processMessage } = createHarness({ dmPolicy: "open" });
    const event = imageEvent("image-preparing-1", "user-image-preparing");

    await expect(receive(event)).rejects.toBeInstanceOf(MediaFetchError);

    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("does not materialize or dispatch media after ingress cancellation", async () => {
    const cancellation = new Error("LINE webhook spool stopped");
    const abort = new AbortController();
    const { receive, processMessage } = createHarness({
      dmPolicy: "open",
      turnAdoptionLifecycle: { ...createTurnAdoptionLifecycleSpy(), abortSignal: abort.signal },
    });
    downloadLineMediaMock.mockImplementationOnce(
      async (
        _messageId: string,
        _token: string,
        _maxBytes: number,
        options?: { signal?: AbortSignal },
      ) => {
        options?.signal?.throwIfAborted();
        throw new Error("download did not receive ingress cancellation");
      },
    );
    const event = imageEvent("image-cancelled-1", "user-image-cancelled");
    abort.abort(cancellation);

    await expect(receive(event)).rejects.toBe(cancellation);

    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps media order and the freshest reply token (indexed=%s)",
    async (indexed) => {
      mockImageDownloads();
      const { receive } = createHarness({
        dmPolicy: "open",
        turnAdoptionLifecycle: createTurnAdoptionLifecycleSpy(),
      });
      const base = 1_700_000_000_000;
      // Indexed sets arrive out of order; older clients omit indexes entirely.
      const order = indexed ? [2, 1, 3] : [1, 2, 3];
      await receive(
        ...order.map((part) =>
          imageSetPart(`m${part}`, base + part * 100, indexed ? part : undefined),
        ),
      );

      const built = buildLineMessageContextMock.mock.calls[0]?.[0];
      expect(built?.allMedia?.map((media) => media.path)).toEqual([
        "/media/m1.png",
        "/media/m2.png",
        "/media/m3.png",
      ]);
      expect(built?.event?.replyToken).toBe(indexed ? "reply-3" : "reply-m3");
    },
  );
});
