import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatSignalMediaText } from "../media-text.js";

const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      type,
      action,
      sessionKey,
      context,
      timestamp: new Date(),
      messages: [],
    }),
  ),
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    createInternalHookEvent: internalHookMocks.createInternalHookEvent,
    triggerInternalHook: internalHookMocks.triggerInternalHook,
  };
});

type SignalMsgContext = Pick<MsgContext, "Body" | "WasMentioned">;

let capturedCtx: SignalMsgContext | undefined;

const getCapturedCtx = () => expectDefined(capturedCtx, "Signal MsgContext");

function getGroupHistoryEntries(
  groupHistories: ReturnType<typeof createBaseSignalEventHandlerDeps>["groupHistories"],
  groupId = "g1",
) {
  return expectDefined(groupHistories.get(groupId), `pending history for ${groupId}`);
}

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  const { createSignalPreparedDispatchRunner } = await import("./event-handler.test-harness.js");
  return {
    ...actual,
    runChannelInboundEvent: createSignalPreparedDispatchRunner(
      actual.runChannelInboundEvent,
      async () => {},
      async (resolved) => {
        capturedCtx = resolved.ctxPayload as SignalMsgContext;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    ),
  };
});

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
  { renderSignalMentions },
  { resolveSignalReplyContextWithPersistence },
] = await Promise.all([
  import("./event-handler.test-harness.js"),
  import("./event-handler.js"),
  import("./mentions.js"),
  import("../reply-authors.js"),
]);

type GroupEventOpts = {
  message?: string;
  attachments?: unknown[];
  quoteText?: string;
  timestamp?: number;
  mentions?: Array<{
    uuid?: string;
    number?: string;
    start?: number;
    length?: number;
  }> | null;
};

function makeGroupEvent(opts: GroupEventOpts) {
  return createSignalReceiveEvent({
    ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
    dataMessage: {
      message: opts.message ?? "",
      attachments: opts.attachments ?? [],
      quote: opts.quoteText ? { text: opts.quoteText } : undefined,
      mentions: opts.mentions ?? undefined,
      groupInfo: { groupId: "g1", groupName: "Test Group" },
    },
  });
}

function createMentionHandler(params: {
  requireMention: boolean;
  mentionPattern?: string | null;
  historyLimit?: number;
  groupHistories?: ReturnType<typeof createBaseSignalEventHandlerDeps>["groupHistories"];
  account?: string;
  accountUuid?: string;
}) {
  const { requireMention, mentionPattern, ...deps } = params;
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: createSignalConfig({ requireMention, mentionPattern }),
      ...deps,
    }),
  );
}

function createSignalConfig(params: { requireMention: boolean; mentionPattern?: string | null }) {
  const mentionPatterns = params.mentionPattern === null ? [] : [params.mentionPattern ?? "@bot"];
  return {
    messages: {
      inbound: { debounceMs: 0 },
      groupChat: { mentionPatterns },
    },
    channels: {
      signal: {
        groups: { "*": { requireMention: params.requireMention } },
      },
    },
  } as unknown as OpenClawConfig;
}

async function expectSkippedGroupHistory(
  opts: GroupEventOpts,
  expectedBody: string,
  expectedMediaText = "",
  mentionOptions: Partial<Parameters<typeof createMentionHandler>[0]> = {},
) {
  capturedCtx = undefined;
  const groupHistories = new Map();
  const handler = createMentionHandler({
    requireMention: true,
    historyLimit: 5,
    groupHistories,
    ...mentionOptions,
  });
  await handler(makeGroupEvent(opts));
  expect(capturedCtx).toBeUndefined();
  const entries = getGroupHistoryEntries(groupHistories);
  expect(entries).toHaveLength(1);
  const entry = expectDefined(entries[0], "Signal group history entry");
  expect(entry.body).toBe(expectedBody);
  expect(formatSignalMediaText(entry.media ?? [])).toBe(expectedMediaText);
}

describe("signal mention gating", () => {
  beforeEach(() => {
    capturedCtx = undefined;
  });

  it("logs identity-derived mention drops once per account and group while preserving history", async () => {
    const log = vi.fn();
    const groupHistories = new Map();
    const createHandler = (accountId: string) =>
      createSignalEventHandler(
        createBaseSignalEventHandlerDeps({
          accountId,
          runtime: { log, error: vi.fn(), exit: vi.fn() },
          groupHistories,
          cfg: { agents: { entries: { main: { identity: { name: "Claw" } } } } },
        }),
      );
    const event = (groupId: string) =>
      createSignalReceiveEvent({
        dataMessage: {
          message: "What up",
          groupInfo: { groupId },
        },
      });
    const handler = createHandler("mention-primary");

    await handler(event("mention-g1"));
    await handler(event("mention-g1"));
    await handler(event("mention-g2"));
    await createHandler("mention-secondary")(event("mention-g1"));

    expect(capturedCtx).toBeUndefined();
    expect(groupHistories.get("mention-g1")).toHaveLength(3);
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls[0]?.[0]).toContain("mention-g1");
    expect(log.mock.calls[1]?.[0]).toContain("mention-g2");
    expect(log.mock.calls[0]?.[0]).toContain("requireMention");
    expect(log.mock.calls[0]?.[0]).toContain("false");
    expect(log.mock.calls.flat().join(" ")).not.toContain("What up");
    expect(log.mock.calls.flat().join(" ")).not.toContain("+15550001111");
  });

  it("allows explicitly configured Signal groups by group id without a mention", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            inbound: { debounceMs: 0 },
            groupChat: { mentionPatterns: ["@bot"] },
          },
          channels: {
            signal: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["group:g1"],
              groups: { g1: {} },
            },
          },
        } as unknown as OpenClawConfig,
        groupPolicy: "allowlist",
        groupAllowFrom: ["group:g1"],
      }),
    );

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(getCapturedCtx().WasMentioned).toBe(false);
  });

  it("records edited target reply authors for skipped group messages", async () => {
    const handler = createMentionHandler({ requireMention: true });

    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000000999,
        editMessage: {
          targetSentTimestamp: 1700000000000,
          dataMessage: {
            timestamp: 1700000000999,
            message: "edited without mention",
            attachments: [],
            groupInfo: { groupId: "g1", groupName: "Test Group" },
          },
        },
      }),
    );

    expect(capturedCtx).toBeUndefined();
    await expect(
      resolveSignalReplyContextWithPersistence({
        accountId: "default",
        to: "group:g1",
        replyToId: "1700000000000",
      }),
    ).resolves.toEqual({ author: "+15550001111", body: "edited without mention" });
  });

  it("records a structured fact for skipped attachment-only group messages", async () => {
    await expectSkippedGroupHistory(
      { message: "", attachments: [{ id: "a1" }], timestamp: 1700000000123 },
      "",
      "<media:attachment>",
    );
    await expect(
      resolveSignalReplyContextWithPersistence({
        accountId: "default",
        to: "group:g1",
        replyToId: "1700000000123",
      }),
    ).resolves.toEqual({
      author: "+15550001111",
      media: [{ contentType: undefined, kind: "unknown" }],
    });
  });

  it("summarizes multiple skipped attachments with stable file count wording", async () => {
    await expectSkippedGroupHistory(
      { message: "", attachments: [{ id: "a1" }, { id: "a2" }] },
      "",
      "[2 files attached]",
    );
  });

  it("records quote text in pending history for skipped quote-only group messages", async () => {
    await expectSkippedGroupHistory({ message: "", quoteText: "quoted context" }, "quoted context");
  });

  it.each([
    [{ accountUuid: "bot-uuid" }, "Hi X!", { uuid: "bot-uuid", start: 3, length: 1 }, "Hi X!"],
    [
      { account: "+15550002222" },
      "please \uFFFC",
      { number: "1 (555) 000-2222", start: 7, length: 1 },
      "@1 (555) 000-2222",
    ],
  ] as const)("allows native bot mentions: %j", async (account, message, mention, body) => {
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: null,
      ...account,
    });
    await handler(makeGroupEvent({ message, mentions: [mention] }));
    expect(getCapturedCtx()).toMatchObject({
      Body: expect.stringContaining(body),
      WasMentioned: true,
    });
  });

  it("does not let an authorized command bypass a native mention of another participant", async () => {
    const placeholder = "\uFFFC";
    await expectSkippedGroupHistory(
      {
        message: `/help ${placeholder}`,
        mentions: [{ uuid: "other-user", start: 6, length: placeholder.length }],
      },
      "/help @other-user",
      "",
      { mentionPattern: null, accountUuid: "bot-uuid" },
    );
  });

  it("does not accept malformed matching native mention metadata as a bot mention", async () => {
    await expectSkippedGroupHistory(
      {
        message: "plain ping",
        mentions: [{ uuid: "bot-uuid", start: 99, length: 1 }],
      },
      "plain ping",
      "",
      { mentionPattern: null, accountUuid: "bot-uuid" },
    );
  });
});

it("renderSignalMentions skips missing identifiers and out-of-bounds spans", () => {
  const normalized = renderSignalMentions("\uFFFC hi", [
    { name: "ignored" },
    { uuid: "valid", start: 0, length: 1 },
    { number: "+1555", start: 999, length: 1 },
  ]);

  expect(normalized).toBe("@valid hi");
});

async function receiveSilentIngest(overrideGroup = false) {
  internalHookMocks.createInternalHookEvent.mockClear();
  internalHookMocks.triggerInternalHook.mockClear();
  const handler = createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: {
        messages: { groupChat: { mentionPatterns: ["@bot"] } },
        channels: {
          signal: {
            groups: {
              "*": { requireMention: true, ingest: true },
              ...(overrideGroup ? { "group-123": { requireMention: true, ingest: false } } : {}),
            },
          },
        },
      } as never,
    }),
  );
  await handler(
    createSignalReceiveEvent({
      dataMessage: {
        message: "hello without mention",
        attachments: [],
        groupInfo: { groupId: "group-123", groupName: "Ops" },
      },
    }),
  );
}

describe("signal mention-skip silent ingest", () => {
  it("emits internal message:received when ingest is enabled", async () => {
    await receiveSilentIngest();
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    const [type, action, sessionKey, context] = expectDefined(
      internalHookMocks.createInternalHookEvent.mock.calls[0],
      "internal hook call",
    );
    expect(type).toBe("message");
    expect(action).toBe("received");
    expect(sessionKey).toContain("signal");
    expect(context).toEqual({
      from: "group:group-123",
      content: "hello without mention",
      timestamp: 1700000000000,
      channelId: "signal",
      accountId: "default",
      conversationId: "group:group-123",
      messageId: "1700000000000",
      metadata: {
        to: "group:group-123",
        provider: "signal",
        surface: "signal",
        threadId: undefined,
        senderId: "+15550001111",
        senderName: "Alice",
        senderUsername: undefined,
        senderE164: undefined,
        guildId: undefined,
        channelName: undefined,
        topicName: undefined,
      },
    });
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("does not emit when group ingest is false and wildcard ingest is true", async () => {
    await receiveSilentIngest(true);
    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });
});
