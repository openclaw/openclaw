// Line tests cover bot handlers plugin behavior.
import type { webhook } from "@line/bot-sdk";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineAccountConfig } from "./types.js";

type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;

// Avoid pulling in globals/pairing/media dependencies; this suite only asserts
// allowlist/groupPolicy gating and message-context wiring.
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  buildMentionRegexes: () => [],
  matchesMentionPatterns: () => false,
}));
vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingChallengeIssuer:
    ({ upsertPairingRequest }: { upsertPairingRequest: (args: unknown) => Promise<unknown> }) =>
    async ({ senderId, onCreated }: { senderId: string; onCreated?: () => void }) => {
      await upsertPairingRequest({ id: senderId, meta: {} });
      onCreated?.();
    },
}));
vi.mock("openclaw/plugin-sdk/command-auth-native", () => ({
  hasControlCommand: (text: string) => text.trim().startsWith("!"),
  shouldComputeCommandAuthorized: (text: string) => text.trim().startsWith("!"),
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
vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (text: string) => text,
  logVerbose: () => {},
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
    clear: ({ historyKey }: { historyKey: string }) => {
      historyMap.delete(historyKey);
    },
  }),
  buildInboundHistoryFromMap: ({
    historyMap,
    historyKey,
    limit,
  }: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
    limit: number;
  }) => {
    if (limit <= 0) {
      return undefined;
    }
    return (historyMap.get(historyKey) ?? []).slice(-limit);
  },
  clearHistoryEntriesIfEnabled: ({
    historyMap,
    historyKey,
  }: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
  }) => {
    historyMap.delete(historyKey);
  },
  recordPendingHistoryEntryIfEnabled: ({
    historyMap,
    historyKey,
    limit,
    entry,
  }: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
    limit: number;
    entry: HistoryEntry;
  }) => {
    const existing = historyMap.get(historyKey) ?? [];
    historyMap.set(historyKey, [...existing, entry].slice(-limit));
  },
}));
vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveAgentRoute: () => ({ agentId: "default" }),
}));

const { readAllowFromStoreMock, upsertPairingRequestMock } = vi.hoisted(() => ({
  readAllowFromStoreMock: vi.fn(async () => [] as string[]),
  upsertPairingRequestMock: vi.fn(async (_args: unknown) => ({ code: "CODE", created: true })),
}));
const downloadLineMediaMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  resolvePairingIdLabel: () => "lineUserId",
  readChannelAllowFromStore: readAllowFromStoreMock,
  upsertChannelPairingRequest: upsertPairingRequestMock,
}));

vi.mock("./download.js", () => ({
  downloadLineMedia: downloadLineMediaMock,
}));

vi.mock("./send.js", () => ({
  pushMessageLine: async () => {
    throw new Error("pushMessageLine should not be called from bot-handlers tests");
  },
  replyMessageLine: async () => {
    throw new Error("replyMessageLine should not be called from bot-handlers tests");
  },
}));

const { buildLineMessageContextMock, buildLinePostbackContextMock } = vi.hoisted(() => ({
  buildLineMessageContextMock: vi.fn(async (_params: { event: MessageEvent }) => ({
    ctxPayload: { From: "line:group:group-1" },
    replyToken: "reply-token",
    route: { agentId: "default" },
    isGroup: true,
    accountId: "default",
  })),
  buildLinePostbackContextMock: vi.fn(async () => null as unknown),
}));

vi.mock("./bot-message-context.js", () => ({
  buildLineMessageContext: buildLineMessageContextMock,
  buildLinePostbackContext: buildLinePostbackContextMock,
  getLineSourceInfo: (source: {
    type?: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  }) => ({
    userId: source.userId,
    groupId: source.type === "group" ? source.groupId : undefined,
    roomId: source.type === "room" ? source.roomId : undefined,
    isGroup: source.type === "group" || source.type === "room",
  }),
}));

let handleLineWebhookEvents: typeof import("./bot-handlers.js").handleLineWebhookEvents;
let createLineWebhookReplayCache: typeof import("./bot-handlers.js").createLineWebhookReplayCache;
let LineRetryableWebhookError: typeof import("./bot-handlers.js").LineRetryableWebhookError;
type LineWebhookContext = Parameters<typeof import("./bot-handlers.js").handleLineWebhookEvents>[1];

const createRuntime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

function createReplayMessageEvent(params: {
  messageId: string;
  groupId: string;
  userId: string;
  webhookEventId: string;
  isRedelivery: boolean;
}) {
  return {
    type: "message",
    message: { id: params.messageId, type: "text", text: "hello", quoteToken: "quote-token" },
    replyToken: "reply-token",
    timestamp: Date.now(),
    source: { type: "group", groupId: params.groupId, userId: params.userId },
    mode: "active",
    webhookEventId: params.webhookEventId,
    deliveryContext: { isRedelivery: params.isRedelivery },
  } as MessageEvent;
}

function createTestMessageEvent(params: {
  message: MessageEvent["message"];
  source: MessageEvent["source"];
  webhookEventId: string;
  timestamp?: number;
  replyToken?: string;
  isRedelivery?: boolean;
}) {
  return {
    type: "message",
    message: params.message,
    replyToken: params.replyToken ?? "reply-token",
    timestamp: params.timestamp ?? Date.now(),
    source: params.source,
    mode: "active",
    webhookEventId: params.webhookEventId,
    deliveryContext: { isRedelivery: params.isRedelivery ?? false },
  } as MessageEvent;
}

function createLineWebhookTestContext(params: {
  processMessage: LineWebhookContext["processMessage"];
  groupPolicy?: LineAccountConfig["groupPolicy"];
  dmPolicy?: LineAccountConfig["dmPolicy"];
  allowFrom?: LineAccountConfig["allowFrom"];
  groupAllowFrom?: LineAccountConfig["groupAllowFrom"];
  requireMention?: boolean;
  requireMentionForNonText?: boolean;
  pendingMediaLimit?: number;
  groupHistories?: Map<string, HistoryEntry[]>;
  pendingMediaQueues?: Map<string, { path: string; contentType?: string }[]>;
  replayCache?: ReturnType<typeof createLineWebhookReplayCache>;
  accessGroups?: Record<string, { type: "message.senders"; members: Record<string, string[]> }>;
}): Parameters<typeof handleLineWebhookEvents>[1] {
  const allowFrom = params.allowFrom ?? (params.dmPolicy === "open" ? ["*"] : undefined);
  const lineConfig = {
    ...(params.groupPolicy ? { groupPolicy: params.groupPolicy } : {}),
    ...(params.dmPolicy ? { dmPolicy: params.dmPolicy } : {}),
    ...(allowFrom ? { allowFrom } : {}),
    ...(params.groupAllowFrom ? { groupAllowFrom: params.groupAllowFrom } : {}),
  };
  const hasGroupOverride =
    params.requireMention !== undefined ||
    params.requireMentionForNonText !== undefined ||
    params.pendingMediaLimit !== undefined;
  return {
    cfg: {
      ...(params.accessGroups ? { accessGroups: params.accessGroups } : {}),
      channels: { line: lineConfig },
    },
    account: {
      accountId: "default",
      enabled: true,
      channelAccessToken: "token",
      channelSecret: "secret",
      tokenSource: "config",
      config: {
        ...lineConfig,
        ...(hasGroupOverride
          ? {
              groups: {
                "*": {
                  ...(params.requireMention === undefined
                    ? {}
                    : { requireMention: params.requireMention }),
                  ...(params.requireMentionForNonText === undefined
                    ? {}
                    : { requireMentionForNonText: params.requireMentionForNonText }),
                  ...(params.pendingMediaLimit === undefined
                    ? {}
                    : { pendingMediaLimit: params.pendingMediaLimit }),
                },
              },
            }
          : {}),
      },
    },
    runtime: createRuntime(),
    mediaMaxBytes: 1,
    processMessage: params.processMessage,
    ...(params.groupHistories ? { groupHistories: params.groupHistories } : {}),
    ...(params.pendingMediaQueues ? { pendingMediaQueues: params.pendingMediaQueues } : {}),
    ...(params.replayCache ? { replayCache: params.replayCache } : {}),
  };
}

function createOpenGroupReplayContext(
  processMessage: LineWebhookContext["processMessage"],
  replayCache: ReturnType<typeof createLineWebhookReplayCache>,
): Parameters<typeof handleLineWebhookEvents>[1] {
  return createLineWebhookTestContext({
    processMessage,
    groupPolicy: "open",
    requireMention: false,
    replayCache,
  });
}

async function expectGroupMessageBlocked(params: {
  processMessage: LineWebhookContext["processMessage"];
  event: MessageEvent;
  context: Parameters<typeof handleLineWebhookEvents>[1];
}) {
  await handleLineWebhookEvents([params.event], params.context);
  expect(params.processMessage).not.toHaveBeenCalled();
  expect(buildLineMessageContextMock).not.toHaveBeenCalled();
}

async function expectRequireMentionGroupMessageProcessed(event: MessageEvent) {
  const processMessage = vi.fn();
  await handleLineWebhookEvents(
    [event],
    createLineWebhookTestContext({
      processMessage,
      groupPolicy: "open",
      requireMention: true,
    }),
  );
  expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
  expect(processMessage).toHaveBeenCalledTimes(1);
}

async function startInflightReplayDuplicate(params: {
  event: MessageEvent;
  processMessage: LineWebhookContext["processMessage"];
}) {
  const context = createOpenGroupReplayContext(
    params.processMessage,
    createLineWebhookReplayCache(),
  );
  const firstRun = handleLineWebhookEvents([params.event], context);
  await Promise.resolve();
  const secondRun = handleLineWebhookEvents([params.event], context);
  return { firstRun, secondRun };
}

describe("handleLineWebhookEvents", () => {
  beforeAll(async () => {
    ({ handleLineWebhookEvents, createLineWebhookReplayCache, LineRetryableWebhookError } =
      await import("./bot-handlers.js"));
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/channel-inbound");
    vi.doUnmock("openclaw/plugin-sdk/channel-pairing");
    vi.doUnmock("openclaw/plugin-sdk/command-auth-native");
    vi.doUnmock("openclaw/plugin-sdk/runtime-group-policy");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/reply-history");
    vi.doUnmock("openclaw/plugin-sdk/routing");
    vi.doUnmock("openclaw/plugin-sdk/conversation-runtime");
    vi.doUnmock("./download.js");
    vi.doUnmock("./send.js");
    vi.doUnmock("./bot-message-context.js");
    vi.resetModules();
  });

  beforeEach(() => {
    buildLineMessageContextMock.mockReset();
    buildLineMessageContextMock.mockImplementation(async () => ({
      ctxPayload: { From: "line:group:group-1" },
      replyToken: "reply-token",
      route: { agentId: "default" },
      isGroup: true,
      accountId: "default",
    }));
    buildLinePostbackContextMock.mockReset();
    buildLinePostbackContextMock.mockImplementation(async () => null as unknown);
    readAllowFromStoreMock.mockReset();
    readAllowFromStoreMock.mockImplementation(async () => [] as string[]);
    upsertPairingRequestMock.mockReset();
    upsertPairingRequestMock.mockImplementation(async () => ({ code: "CODE", created: true }));
    downloadLineMediaMock.mockReset();
    downloadLineMediaMock.mockImplementation(async () => {
      throw new Error("downloadLineMedia should not be called from bot-handlers tests");
    });
  });
  it("blocks group messages when groupPolicy is disabled", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m1", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-1" },
      mode: "active",
      webhookEventId: "evt-1",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { groupPolicy: "disabled" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "disabled" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("blocks group messages when allowlist is empty", async () => {
    const processMessage = vi.fn();
    await expectGroupMessageBlocked({
      processMessage,
      event: createTestMessageEvent({
        message: { id: "m2", type: "text", text: "hi", quoteToken: "quote-token" },
        source: { type: "group", groupId: "group-1", userId: "user-2" },
        webhookEventId: "evt-2",
      }),
      context: createLineWebhookTestContext({
        processMessage,
        groupPolicy: "allowlist",
      }),
    });
  });

  it("allows group messages when sender is in groupAllowFrom", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m3", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-3" },
      mode: "active",
      webhookEventId: "evt-3",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-3"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["user-3"],
          groups: { "*": { requireMention: false } },
        },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("authorizes group control commands through shared access groups", async () => {
    const processMessage = vi.fn();
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: { id: "m3a", type: "text", text: "!status", quoteToken: "quote-token" },
          source: { type: "group", groupId: "group-1", userId: "user-ag" },
          webhookEventId: "evt-3a",
        }),
      ],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:line-operators"],
        requireMention: true,
        accessGroups: {
          "line-operators": {
            type: "message.senders",
            members: { line: ["user-ag"] },
          },
        },
      }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks unauthorized group control commands even when an open group sender is allowed", async () => {
    const processMessage = vi.fn();
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: { id: "m3b", type: "text", text: "!status", quoteToken: "quote-token" },
          source: { type: "group", groupId: "group-1", userId: "user-open" },
          webhookEventId: "evt-3b",
        }),
      ],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
      }),
    );

    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("blocks group sender not in groupAllowFrom without consulting the DM pairing store", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m5", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-store" },
      mode: "active",
      webhookEventId: "evt-5",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-group"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "allowlist", groupAllowFrom: ["user-group"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("blocks group messages without sender id when groupPolicy is allowlist", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m5a", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1" },
      mode: "active",
      webhookEventId: "evt-5a",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-5"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "allowlist", groupAllowFrom: ["user-5"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("does not authorize group messages from DM pairing-store entries when group allowlist is empty", async () => {
    const processMessage = vi.fn();
    await expectGroupMessageBlocked({
      processMessage,
      event: createTestMessageEvent({
        message: { id: "m5b", type: "text", text: "hi", quoteToken: "quote-token" },
        source: { type: "group", groupId: "group-1", userId: "user-5" },
        webhookEventId: "evt-5b",
      }),
      context: {
        cfg: { channels: { line: { groupPolicy: "allowlist" } } },
        account: {
          accountId: "default",
          enabled: true,
          channelAccessToken: "token",
          channelSecret: "secret",
          tokenSource: "config",
          config: {
            dmPolicy: "pairing",
            allowFrom: [],
            groupPolicy: "allowlist",
            groupAllowFrom: [],
          },
        },
        runtime: createRuntime(),
        mediaMaxBytes: 1,
        processMessage,
      },
    });
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("blocks group messages when wildcard group config disables groups", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m4", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-2", userId: "user-4" },
      mode: "active",
      webhookEventId: "evt-4",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { groupPolicy: "open" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "open", groups: { "*": { enabled: false } } },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("scopes DM pairing requests to accountId", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m5", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "user", userId: "user-5" },
      mode: "active",
      webhookEventId: "evt-5",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { dmPolicy: "pairing" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { dmPolicy: "pairing", allowFrom: ["user-owner"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    const pairingRequest = (upsertPairingRequestMock.mock.calls as unknown[][])[0]?.[0] as
      | { accountId?: string; channel?: string; id?: string }
      | undefined;
    expect(pairingRequest?.channel).toBe("line");
    expect(pairingRequest?.id).toBe("user-5");
    expect(pairingRequest?.accountId).toBe("default");
  });

  it("does not authorize DM senders from another account's pairing-store entries", async () => {
    const processMessage = vi.fn();
    readAllowFromStoreMock.mockImplementation(async (...args: unknown[]) => {
      const accountId = args[2] as string | undefined;
      if (accountId === "work") {
        return [];
      }
      return ["cross-account-user"];
    });
    upsertPairingRequestMock.mockResolvedValue({ code: "CODE", created: false });

    const event = {
      type: "message",
      message: { id: "m6", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "user", userId: "cross-account-user" },
      mode: "active",
      webhookEventId: "evt-6",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { dmPolicy: "pairing" } } },
      account: {
        accountId: "work",
        enabled: true,
        channelAccessToken: "token-work", // pragma: allowlist secret
        channelSecret: "secret-work", // pragma: allowlist secret
        tokenSource: "config",
        config: { dmPolicy: "pairing" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(readAllowFromStoreMock).toHaveBeenCalledWith("line", undefined, "work");
    expect(processMessage).not.toHaveBeenCalled();
    const pairingRequest = (upsertPairingRequestMock.mock.calls as unknown[][])[0]?.[0] as
      | { accountId?: string; channel?: string; id?: string }
      | undefined;
    expect(pairingRequest?.channel).toBe("line");
    expect(pairingRequest?.id).toBe("cross-account-user");
    expect(pairingRequest?.accountId).toBe("work");
  });

  it("deduplicates replayed webhook events by webhookEventId before processing", async () => {
    const processMessage = vi.fn();
    const event = createReplayMessageEvent({
      messageId: "m-replay",
      groupId: "group-replay",
      userId: "user-replay",
      webhookEventId: "evt-replay-1",
      isRedelivery: true,
    });
    const context = createOpenGroupReplayContext(processMessage, createLineWebhookReplayCache());

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents([event], context);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("skips concurrent redeliveries while the first event is still processing", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const processMessage = vi.fn(async () => {
      await firstDone;
    });
    const event = createReplayMessageEvent({
      messageId: "m-inflight",
      groupId: "group-inflight",
      userId: "user-inflight",
      webhookEventId: "evt-inflight-1",
      isRedelivery: true,
    });
    const { firstRun, secondRun } = await startInflightReplayDuplicate({ event, processMessage });
    resolveFirst?.();
    await Promise.all([firstRun, secondRun]);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("mirrors in-flight retryable replay failures so concurrent duplicates also fail", async () => {
    let rejectFirst: ((err: Error) => void) | undefined;
    const firstDone = new Promise<void>((_, reject) => {
      rejectFirst = reject;
    });
    const processMessage = vi.fn(async () => {
      await firstDone;
    });
    const event = createReplayMessageEvent({
      messageId: "m-inflight-fail",
      groupId: "group-inflight",
      userId: "user-inflight",
      webhookEventId: "evt-inflight-fail-1",
      isRedelivery: true,
    });
    const { firstRun, secondRun } = await startInflightReplayDuplicate({ event, processMessage });
    const firstFailure = expect(firstRun).rejects.toThrow("transient inflight failure");
    const secondFailure = expect(secondRun).rejects.toThrow("transient inflight failure");
    rejectFirst?.(new LineRetryableWebhookError("transient inflight failure"));

    await Promise.all([firstFailure, secondFailure]);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates redeliveries by LINE message id when webhookEventId changes", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m-dup-1", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-dup", userId: "user-dup" },
      mode: "active",
      webhookEventId: "evt-dup-1",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-dup"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["user-dup"],
          groups: { "*": { requireMention: false } },
        },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
    };

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents(
      [
        {
          ...event,
          webhookEventId: "evt-dup-redelivery",
          deliveryContext: { isRedelivery: true },
        } as MessageEvent,
      ],
      context,
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates postback redeliveries by webhookEventId when replyToken changes", async () => {
    const processMessage = vi.fn();
    buildLinePostbackContextMock.mockResolvedValue({
      ctxPayload: { From: "line:user:user-postback" },
      route: { agentId: "default" },
      isGroup: false,
      accountId: "default",
    });
    const event = {
      type: "postback",
      postback: { data: "action=confirm" },
      replyToken: "reply-token-1",
      timestamp: Date.now(),
      source: { type: "user", userId: "user-postback" },
      mode: "active",
      webhookEventId: "evt-postback-1",
      deliveryContext: { isRedelivery: false },
    } as PostbackEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      cfg: { channels: { line: { dmPolicy: "open", allowFrom: ["*"] } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { dmPolicy: "open", allowFrom: ["*"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
    };

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents(
      [
        {
          ...event,
          replyToken: "reply-token-2",
          deliveryContext: { isRedelivery: true },
        } as PostbackEvent,
      ],
      context,
    );

    expect(buildLinePostbackContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("skips group messages by default when requireMention is not configured", async () => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: { id: "m-default-skip", type: "text", text: "hi there", quoteToken: "q-default" },
      source: { type: "group", groupId: "group-default", userId: "user-default" },
      webhookEventId: "evt-default-skip",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
      }),
    );

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("records unmentioned group messages as pending history", async () => {
    const processMessage = vi.fn();
    const groupHistories = new Map<string, HistoryEntry[]>();
    const event = createTestMessageEvent({
      message: { id: "m-hist-1", type: "text", text: "hello history", quoteToken: "q-hist-1" },
      timestamp: 1700000000000,
      source: { type: "group", groupId: "group-hist-1", userId: "user-hist" },
      webhookEventId: "evt-hist-1",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        groupHistories,
      }),
    );

    expect(processMessage).not.toHaveBeenCalled();
    const entries = groupHistories.get("group-hist-1");
    expect(entries).toHaveLength(1);
    const entry = entries?.[0];
    expect(entry?.sender).toBe("user:user-hist");
    expect(entry?.body).toBe("hello history");
    expect(entry?.timestamp).toBe(1700000000000);
  });

  it("skips group messages without mention when requireMention is set", async () => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: { id: "m-mention-1", type: "text", text: "hi there", quoteToken: "q-mention-1" },
      source: { type: "group", groupId: "group-mention", userId: "user-mention" },
      webhookEventId: "evt-mention-1",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
      }),
    );

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("processes group messages with bot mention when requireMention is set", async () => {
    const processMessage = vi.fn();
    // Simulate a LINE text message with mention.mentionees containing isSelf=true
    const event = createTestMessageEvent({
      message: {
        id: "m-mention-2",
        type: "text",
        text: "@Bot hi there",
        mention: {
          mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }],
        },
      } as unknown as MessageEvent["message"],
      source: { type: "group", groupId: "group-mention", userId: "user-mention" },
      webhookEventId: "evt-mention-2",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
      }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("processes group messages with @all mention when requireMention is set", async () => {
    const event = createTestMessageEvent({
      message: {
        id: "m-mention-3",
        type: "text",
        text: "@All hi there",
        mention: {
          mentionees: [{ index: 0, length: 4, type: "all" }],
        },
      } as MessageEvent["message"],
      source: { type: "group", groupId: "group-mention", userId: "user-mention" },
      webhookEventId: "evt-mention-3",
    });

    await expectRequireMentionGroupMessageProcessed(event);
  });

  it("does not apply requireMention gating to DM messages", async () => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: { id: "m-mention-dm", type: "text", text: "hi", quoteToken: "q-mention-dm" },
      source: { type: "user", userId: "user-dm" },
      webhookEventId: "evt-mention-dm",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        dmPolicy: "open",
        requireMention: true,
      }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("forwards LINE file names to media downloads", async () => {
    const processMessage = vi.fn();
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

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        dmPolicy: "open",
      }),
    );

    expect(downloadLineMediaMock).toHaveBeenCalledWith("file-audio-1", "token", 1, {
      originalFilename: "voice-note.m4a",
    });
    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allMedia: [
          {
            path: "/tmp/line-media/voice-note.m4a",
            contentType: "audio/x-m4a",
          },
        ],
      }),
    );
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("reports failed media materialization to the message-context owner", async () => {
    downloadLineMediaMock.mockRejectedValueOnce(new Error("expired content"));
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: {
        id: "image-failed-1",
        type: "image",
        contentProvider: { type: "line" },
        quoteToken: "q-image-failed",
      },
      source: { type: "user", userId: "user-image-failed" },
      webhookEventId: "evt-image-failed",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({ processMessage, dmPolicy: "open" }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ allMedia: [], mediaUnavailable: true }),
    );
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("allows non-text group messages through when requireMention is set (cannot detect mention)", async () => {
    // Image message -- LINE only carries mention metadata on text messages.
    const event = createTestMessageEvent({
      message: {
        id: "m-mention-img",
        type: "image",
        contentProvider: { type: "line" },
        quoteToken: "q-mention-img",
      },
      source: { type: "group", groupId: "group-1", userId: "user-img" },
      webhookEventId: "evt-mention-img",
    });

    await expectRequireMentionGroupMessageProcessed(event);
  });

  it("skips unmentioned non-text group messages when requireMentionForNonText is set", async () => {
    const processMessage = vi.fn();
    downloadLineMediaMock.mockImplementation(async () => ({
      path: "/media/skip-1.jpg",
      contentType: "image/jpeg",
    }));
    const event = createTestMessageEvent({
      message: {
        id: "m-nontext-gate",
        type: "image",
        contentProvider: { type: "line" },
        quoteToken: "q-nontext-gate",
      },
      source: { type: "group", groupId: "group-1", userId: "user-nontext-gate" },
      webhookEventId: "evt-nontext-gate",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
        requireMentionForNonText: true,
      }),
    );

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("caps the pending media queue at pendingMediaLimit, keeping only the most recent entries", async () => {
    const processMessage = vi.fn();
    let counter = 0;
    downloadLineMediaMock.mockImplementation(async () => {
      counter += 1;
      return { path: `/media/pending-${counter}.jpg`, contentType: "image/jpeg" };
    });
    const pendingMediaQueues = new Map<string, { path: string; contentType?: string }[]>();
    const context = createLineWebhookTestContext({
      processMessage,
      groupPolicy: "open",
      requireMention: true,
      requireMentionForNonText: true,
      pendingMediaLimit: 2,
      pendingMediaQueues,
    });

    for (let i = 1; i <= 3; i += 1) {
      const event = createTestMessageEvent({
        message: {
          id: `m-pending-${i}`,
          type: "image",
          contentProvider: { type: "line" },
          quoteToken: `q-pending-${i}`,
        },
        source: { type: "group", groupId: "group-pending", userId: "user-pending" },
        webhookEventId: `evt-pending-${i}`,
      });
      await handleLineWebhookEvents([event], context);
    }

    expect(processMessage).not.toHaveBeenCalled();
    const queue = pendingMediaQueues.get("group-pending");
    expect(queue).toHaveLength(2);
    expect(queue?.map((m) => m.path)).toEqual(["/media/pending-2.jpg", "/media/pending-3.jpg"]);
  });

  it("flushes queued pending media into allMedia when a later mentioned message triggers processing, then clears the queue", async () => {
    const processMessage = vi.fn();
    downloadLineMediaMock.mockImplementation(async () => ({
      path: "/media/queued-1.jpg",
      contentType: "image/jpeg",
    }));
    const pendingMediaQueues = new Map<string, { path: string; contentType?: string }[]>();
    const context = createLineWebhookTestContext({
      processMessage,
      groupPolicy: "open",
      requireMention: true,
      requireMentionForNonText: true,
      pendingMediaQueues,
    });

    const skippedEvent = createTestMessageEvent({
      message: {
        id: "m-flush-img",
        type: "image",
        contentProvider: { type: "line" },
        quoteToken: "q-flush-img",
      },
      source: { type: "group", groupId: "group-flush", userId: "user-flush" },
      webhookEventId: "evt-flush-img",
    });
    await handleLineWebhookEvents([skippedEvent], context);
    expect(pendingMediaQueues.get("group-flush")).toHaveLength(1);

    const mentionedEvent = createTestMessageEvent({
      message: {
        id: "m-flush-text",
        type: "text",
        text: "@bot check this out",
        mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] },
      } as unknown as MessageEvent["message"],
      source: { type: "group", groupId: "group-flush", userId: "user-flush" },
      webhookEventId: "evt-flush-text",
    });
    await handleLineWebhookEvents([mentionedEvent], context);

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allMedia: [{ path: "/media/queued-1.jpg", contentType: "image/jpeg" }],
      }),
    );
    expect(pendingMediaQueues.has("group-flush")).toBe(false);
  });

  it("does not flush queued pending media into a control-command that only bypassed requireMention (no real mention)", async () => {
    const processMessage = vi.fn();
    downloadLineMediaMock.mockImplementation(async () => ({
      path: "/media/bypass-1.jpg",
      contentType: "image/jpeg",
    }));
    const pendingMediaQueues = new Map<string, { path: string; contentType?: string }[]>();
    const context = createLineWebhookTestContext({
      processMessage,
      groupPolicy: "open",
      groupAllowFrom: ["accessGroup:line-operators"],
      requireMention: true,
      requireMentionForNonText: true,
      pendingMediaQueues,
      accessGroups: {
        "line-operators": {
          type: "message.senders",
          members: { line: ["user-bypass"] },
        },
      },
    });

    // First, an unmentioned image from an allowed sender gets queued (group is
    // "open" so any sender can post, but requireMention blocks dispatch).
    const skippedEvent = createTestMessageEvent({
      message: {
        id: "m-bypass-img",
        type: "image",
        contentProvider: { type: "line" },
        quoteToken: "q-bypass-img",
      },
      source: { type: "group", groupId: "group-bypass", userId: "user-bypass" },
      webhookEventId: "evt-bypass-img",
    });
    await handleLineWebhookEvents([skippedEvent], context);
    expect(pendingMediaQueues.get("group-bypass")).toHaveLength(1);

    // Then a control command with no actual @mention arrives from an
    // authorized sender. requireMention is bypassed for control-command
    // authorization, but that bypass must not also flush someone else's
    // queued media into this command's context (PR #103761 review Bug 2).
    const controlCommandEvent = createTestMessageEvent({
      message: { id: "m-bypass-cmd", type: "text", text: "!status", quoteToken: "q-bypass-cmd" },
      source: { type: "group", groupId: "group-bypass", userId: "user-bypass" },
      webhookEventId: "evt-bypass-cmd",
    });
    await handleLineWebhookEvents([controlCommandEvent], context);

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ allMedia: [] }),
    );
    // The queued media must survive untouched since it was never flushed.
    expect(pendingMediaQueues.get("group-bypass")).toHaveLength(1);
  });

  it("keeps queued pending media when processMessage fails, so it can be retried", async () => {
    const processMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("downstream processing failed"))
      .mockResolvedValueOnce(undefined);
    downloadLineMediaMock.mockImplementation(async () => ({
      path: "/media/retry-1.jpg",
      contentType: "image/jpeg",
    }));
    const pendingMediaQueues = new Map<string, { path: string; contentType?: string }[]>();
    const context = createLineWebhookTestContext({
      processMessage,
      groupPolicy: "open",
      requireMention: true,
      requireMentionForNonText: true,
      pendingMediaQueues,
    });

    const skippedEvent = createTestMessageEvent({
      message: {
        id: "m-retry-img",
        type: "image",
        contentProvider: { type: "line" },
        quoteToken: "q-retry-img",
      },
      source: { type: "group", groupId: "group-retry-media", userId: "user-retry-media" },
      webhookEventId: "evt-retry-img",
    });
    await handleLineWebhookEvents([skippedEvent], context);
    expect(pendingMediaQueues.get("group-retry-media")).toHaveLength(1);

    const mentionedEvent = createTestMessageEvent({
      message: {
        id: "m-retry-text",
        type: "text",
        text: "@bot check this out",
        mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] },
      } as unknown as MessageEvent["message"],
      source: { type: "group", groupId: "group-retry-media", userId: "user-retry-media" },
      webhookEventId: "evt-retry-text",
    });

    // First attempt: processMessage throws. The queue must be preserved so a
    // LINE webhook retry can recover the media (PR #103761 review Bug 1).
    await expect(handleLineWebhookEvents([mentionedEvent], context)).rejects.toThrow(
      "downstream processing failed",
    );
    expect(pendingMediaQueues.get("group-retry-media")).toHaveLength(1);

    // Retry (same webhookEventId reused conceptually as a distinct retry event):
    // second attempt succeeds and the queue is now cleared.
    const retryEvent = createTestMessageEvent({
      message: mentionedEvent.message,
      source: mentionedEvent.source,
      webhookEventId: "evt-retry-text-2",
    });
    await handleLineWebhookEvents([retryEvent], context);

    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(buildLineMessageContextMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allMedia: [{ path: "/media/retry-1.jpg", contentType: "image/jpeg" }],
      }),
    );
    expect(pendingMediaQueues.has("group-retry-media")).toBe(false);
  });

  it("defaults pendingMediaLimit to 3 when unset", async () => {
    const processMessage = vi.fn();
    let counter = 0;
    downloadLineMediaMock.mockImplementation(async () => {
      counter += 1;
      return { path: `/media/default-${counter}.jpg`, contentType: "image/jpeg" };
    });
    const pendingMediaQueues = new Map<string, { path: string; contentType?: string }[]>();
    const context = createLineWebhookTestContext({
      processMessage,
      groupPolicy: "open",
      requireMention: true,
      requireMentionForNonText: true,
      pendingMediaQueues,
    });

    for (let i = 1; i <= 4; i += 1) {
      const event = createTestMessageEvent({
        message: {
          id: `m-default-${i}`,
          type: "image",
          contentProvider: { type: "line" },
          quoteToken: `q-default-${i}`,
        },
        source: { type: "group", groupId: "group-default", userId: "user-default" },
        webhookEventId: `evt-default-${i}`,
      });
      await handleLineWebhookEvents([event], context);
    }

    const queue = pendingMediaQueues.get("group-default");
    expect(queue).toHaveLength(3);
    expect(queue?.map((m) => m.path)).toEqual([
      "/media/default-2.jpg",
      "/media/default-3.jpg",
      "/media/default-4.jpg",
    ]);
  });

  it("does not bypass mention gating when non-bot mention is present with control command", async () => {
    const processMessage = vi.fn();
    // Text message mentions another user (not bot) together with a control command.
    const event = createTestMessageEvent({
      message: {
        id: "m-mention-other",
        type: "text",
        text: "@other !status",
        mention: { mentionees: [{ index: 0, length: 6, type: "user", isSelf: false }] },
      } as unknown as MessageEvent["message"],
      source: { type: "group", groupId: "group-1", userId: "user-other" },
      webhookEventId: "evt-mention-other",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
      }),
    );

    // Should be skipped because there is a non-bot mention and the bot was not mentioned.
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("keeps replay cache committed after a non-retryable event failure", async () => {
    const processMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce(undefined);
    const event = createReplayMessageEvent({
      messageId: "m-fail-then-retry",
      groupId: "group-retry",
      userId: "user-retry",
      webhookEventId: "evt-fail-then-retry",
      isRedelivery: false,
    });
    const context = createOpenGroupReplayContext(processMessage, createLineWebhookReplayCache());

    await expect(handleLineWebhookEvents([event], context)).rejects.toThrow("transient failure");
    await handleLineWebhookEvents([event], context);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(context.runtime.error).toHaveBeenCalledWith(
      "line: event handler failed: Error: transient failure",
    );
  });

  it("reopens replay after an explicit retryable event failure", async () => {
    const processMessage = vi
      .fn()
      .mockRejectedValueOnce(new LineRetryableWebhookError("retry me"))
      .mockResolvedValueOnce(undefined);
    const event = createReplayMessageEvent({
      messageId: "m-fail-then-retryable",
      groupId: "group-retry",
      userId: "user-retry",
      webhookEventId: "evt-fail-then-retryable",
      isRedelivery: false,
    });
    const context = createOpenGroupReplayContext(processMessage, createLineWebhookReplayCache());

    await expect(handleLineWebhookEvents([event], context)).rejects.toThrow("retry me");
    await handleLineWebhookEvents([event], context);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(2);
    expect(processMessage).toHaveBeenCalledTimes(2);
  });

  describe("pending-media queue concurrency (PR #103761 review)", () => {
    function createMentionedTextEvent(params: {
      groupId: string;
      userId: string;
      messageId: string;
      webhookEventId: string;
    }) {
      return createTestMessageEvent({
        message: {
          id: params.messageId,
          type: "text",
          text: "@bot check this out",
          mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] },
        } as unknown as MessageEvent["message"],
        source: { type: "group", groupId: params.groupId, userId: params.userId },
        webhookEventId: params.webhookEventId,
      });
    }

    function createSkippedImageEvent(params: {
      groupId: string;
      userId: string;
      messageId: string;
      webhookEventId: string;
    }) {
      return createTestMessageEvent({
        message: {
          id: params.messageId,
          type: "image",
          contentProvider: { type: "line" },
          quoteToken: `q-${params.messageId}`,
        },
        source: { type: "group", groupId: params.groupId, userId: params.userId },
        webhookEventId: params.webhookEventId,
      });
    }

    it("serializes overlapping webhook deliveries for the same group so pending media is consumed only once", async () => {
      // Two *separate* handleLineWebhookEvents calls simulate two concurrent
      // HTTP webhook deliveries for the same LINE group (handleWebhook is
      // invoked once per HTTP request in bot.ts). A single batch's events are
      // already processed sequentially by the existing for-of loop, so this
      // is the scenario that actually needs the lock.
      let releaseFirst: (() => void) | undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let callCount = 0;
      const processMessage = vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          await firstGate;
        }
      });
      const pendingMediaQueues = new Map<string, { path: string; contentType?: string }[]>([
        ["group-race", [{ path: "/media/queued-race.jpg", contentType: "image/jpeg" }]],
      ]);
      const context = createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
        pendingMediaQueues,
      });

      const firstRun = handleLineWebhookEvents(
        [
          createMentionedTextEvent({
            groupId: "group-race",
            userId: "user-race",
            messageId: "m-race-1",
            webhookEventId: "evt-race-1",
          }),
        ],
        context,
      );
      await vi.waitFor(() => {
        expect(processMessage).toHaveBeenCalledTimes(1);
      });
      const secondRun = handleLineWebhookEvents(
        [
          createMentionedTextEvent({
            groupId: "group-race",
            userId: "user-race",
            messageId: "m-race-2",
            webhookEventId: "evt-race-2",
          }),
        ],
        context,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The second delivery must be queued behind the first's critical
      // section (lock held), not racing into it: processMessage must not
      // have been called a second time yet.
      expect(processMessage).toHaveBeenCalledTimes(1);

      releaseFirst?.();
      await Promise.all([firstRun, secondRun]);

      expect(processMessage).toHaveBeenCalledTimes(2);
      const calls = buildLineMessageContextMock.mock.calls as unknown as Array<
        [{ allMedia: Array<{ path: string }> }]
      >;
      const callsThatSawQueuedMedia = calls.filter((call) =>
        call[0].allMedia.some((m) => m.path === "/media/queued-race.jpg"),
      );
      // Exactly one of the two overlapping deliveries may have consumed the
      // queued media snapshot; without the lock both could observe it before
      // either cleared the queue.
      expect(callsThatSawQueuedMedia).toHaveLength(1);
      expect(pendingMediaQueues.has("group-race")).toBe(false);
    });

    it("does not serialize unrelated groups: a slow group does not block a different group", async () => {
      let releaseSlow: (() => void) | undefined;
      const slowGate = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      const callOrder: string[] = [];
      const processMessage = vi.fn(async (ctx: { ctxPayload?: { From?: string } }) => {
        const from = ctx?.ctxPayload?.From ?? "unknown";
        if (from.includes("group-slow")) {
          callOrder.push("slow-start");
          await slowGate;
          callOrder.push("slow-end");
        } else {
          callOrder.push("fast-start");
          callOrder.push("fast-end");
        }
      });
      buildLineMessageContextMock.mockImplementation(async (params: { event: MessageEvent }) => {
        const source = params.event.source as { groupId?: string };
        return {
          ctxPayload: { From: `line:group:${source.groupId}` },
          replyToken: "reply-token",
          route: { agentId: "default" },
          isGroup: true,
          accountId: "default",
        };
      });
      const pendingMediaQueues = new Map<string, { path: string; contentType?: string }[]>();
      const context = createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
        pendingMediaQueues,
      });

      const slowRun = handleLineWebhookEvents(
        [
          createMentionedTextEvent({
            groupId: "group-slow",
            userId: "user-slow",
            messageId: "m-slow-1",
            webhookEventId: "evt-slow-1",
          }),
        ],
        context,
      );
      await Promise.resolve();
      await Promise.resolve();

      // A different group's delivery must complete without waiting on the
      // still-in-flight "group-slow" delivery's lock.
      const fastRun = handleLineWebhookEvents(
        [
          createMentionedTextEvent({
            groupId: "group-fast",
            userId: "user-fast",
            messageId: "m-fast-1",
            webhookEventId: "evt-fast-1",
          }),
        ],
        context,
      );
      await fastRun;

      expect(callOrder).toEqual(["slow-start", "fast-start", "fast-end"]);

      releaseSlow?.();
      await slowRun;
      expect(callOrder).toEqual(["slow-start", "fast-start", "fast-end", "slow-end"]);
    });

    it("guards concurrent queue writes against a concurrent flush for the same group (no lost update)", async () => {
      let releaseMentioned: (() => void) | undefined;
      const mentionedGate = new Promise<void>((resolve) => {
        releaseMentioned = resolve;
      });
      const processMessage = vi.fn(async () => {
        await mentionedGate;
      });
      downloadLineMediaMock.mockImplementation(async () => ({
        path: "/media/write-race.jpg",
        contentType: "image/jpeg",
      }));
      const pendingMediaQueues = new Map<string, { path: string; contentType?: string }[]>();
      const context = createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
        requireMentionForNonText: true,
        pendingMediaQueues,
      });

      // A mentioned event acquires the group's pending-media lock first and
      // blocks (inside processMessage) while holding it.
      const mentionedRun = handleLineWebhookEvents(
        [
          createMentionedTextEvent({
            groupId: "group-write-race",
            userId: "user-write-race",
            messageId: "m-write-race-mentioned",
            webhookEventId: "evt-write-race-mentioned",
          }),
        ],
        context,
      );
      await Promise.resolve();
      await Promise.resolve();

      // While the lock is held, an unrelated skipped (non-mentioned) image in
      // the same group tries to enqueue pending media. This write path must
      // also be guarded by the lock, so it cannot run concurrently with (and
      // have its write lost to) the in-flight flush/clear above.
      const skippedRun = handleLineWebhookEvents(
        [
          createSkippedImageEvent({
            groupId: "group-write-race",
            userId: "user-write-race",
            messageId: "m-write-race-skip",
            webhookEventId: "evt-write-race-skip",
          }),
        ],
        context,
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(downloadLineMediaMock).not.toHaveBeenCalled();
      expect(pendingMediaQueues.has("group-write-race")).toBe(false);

      releaseMentioned?.();
      await Promise.all([mentionedRun, skippedRun]);

      // The skipped image's write only happens after the mentioned flush's
      // critical section fully released the lock, so it is not lost.
      expect(downloadLineMediaMock).toHaveBeenCalledTimes(1);
      expect(pendingMediaQueues.get("group-write-race")).toEqual([
        { path: "/media/write-race.jpg", contentType: "image/jpeg" },
      ]);
    });
  });
});
