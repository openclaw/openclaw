// Signal tests cover event handler.mention gating plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { buildDispatchInboundCaptureMock } from "openclaw/plugin-sdk/channel-contract-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { HistoryMediaEntry } from "openclaw/plugin-sdk/reply-history";
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

vi.mock("openclaw/plugin-sdk/hook-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/hook-runtime")>(
    "openclaw/plugin-sdk/hook-runtime",
  );
  return {
    ...actual,
    createInternalHookEvent: internalHookMocks.createInternalHookEvent,
    triggerInternalHook: internalHookMocks.triggerInternalHook,
  };
});

type SignalMsgContext = Pick<MsgContext, "Body" | "WasMentioned"> & {
  Body?: string;
  WasMentioned?: boolean;
};

let capturedCtx: SignalMsgContext | undefined;

function getCapturedCtx() {
  if (!capturedCtx) {
    throw new Error("expected captured Signal MsgContext");
  }
  return capturedCtx;
}

function getGroupHistoryEntries(
  groupHistories: Map<
    string,
    Array<{
      sender?: string;
      body?: string;
      media?: HistoryMediaEntry[];
      timestamp?: number;
      messageId?: string;
    }>
  >,
  groupId = "g1",
) {
  const entries = groupHistories.get(groupId);
  if (!entries) {
    throw new Error(`expected pending history for ${groupId}`);
  }
  return entries;
}

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return buildDispatchInboundCaptureMock(actual, (ctx) => {
    capturedCtx = ctx as SignalMsgContext;
  });
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
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
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: createSignalConfig({
        requireMention: params.requireMention,
        mentionPattern: params.mentionPattern,
      }),
      ...(typeof params.historyLimit === "number" ? { historyLimit: params.historyLimit } : {}),
      ...(params.groupHistories ? { groupHistories: params.groupHistories } : {}),
      ...(params.account ? { account: params.account } : {}),
      ...(params.accountUuid ? { accountUuid: params.accountUuid } : {}),
    }),
  );
}

function createMentionGatedHistoryHandler() {
  const groupHistories = new Map();
  const handler = createMentionHandler({ requireMention: true, historyLimit: 5, groupHistories });
  return { handler, groupHistories };
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
) {
  capturedCtx = undefined;
  const { handler, groupHistories } = createMentionGatedHistoryHandler();
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
    const { handler } = createMentionGatedHistoryHandler();

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
    const groupHistories = new Map();
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createSignalConfig({ requireMention: true }),
        historyLimit: 5,
        groupHistories,
        ignoreAttachments: false,
        fetchAttachment: async ({ attachment }) => ({
          path: `/tmp/${String(attachment.id)}.bin`,
        }),
      }),
    );

    await handler(
      makeGroupEvent({
        message: "",
        attachments: [{ id: "a1" }, { id: "a2" }],
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = getGroupHistoryEntries(groupHistories);
    expect(entries).toHaveLength(1);
    const entry = expectDefined(entries[0], "Signal attachment history entry");
    expect(entry.body).toBe("");
    expect(formatSignalMediaText(entry.media ?? [])).toBe("[2 files attached]");
  });

  it("records quote text in pending history for skipped quote-only group messages", async () => {
    await expectSkippedGroupHistory({ message: "", quoteText: "quoted context" }, "quoted context");
  });

  it("allows native bot UUID mentions without a text mention pattern", async () => {
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: null,
      accountUuid: "bot-uuid",
    });
    await handler(
      makeGroupEvent({
        message: "Hi X!",
        mentions: [{ uuid: "bot-uuid", start: 3, length: 1 }],
      }),
    );

    expect(getCapturedCtx()?.Body).toContain("Hi X!");
    expect(getCapturedCtx().WasMentioned).toBe(true);
  });

  it("allows native bot phone mentions after E.164 normalization", async () => {
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: null,
      account: "+15550002222",
    });
    const placeholder = "\uFFFC";

    await handler(
      makeGroupEvent({
        message: `please ${placeholder}`,
        mentions: [{ number: "1 (555) 000-2222", start: 7, length: placeholder.length }],
      }),
    );

    expect(getCapturedCtx()?.Body ?? "").toContain("@1 (555) 000-2222");
    expect(getCapturedCtx().WasMentioned).toBe(true);
  });

  it("does not let an authorized command bypass a native mention of another participant", async () => {
    const groupHistories = new Map();
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: null,
      accountUuid: "bot-uuid",
      groupHistories,
    });
    const placeholder = "\uFFFC";

    await handler(
      makeGroupEvent({
        message: `/help ${placeholder}`,
        mentions: [{ uuid: "other-user", start: 6, length: placeholder.length }],
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = getGroupHistoryEntries(groupHistories);
    expect(entries).toHaveLength(1);
    expect(expectDefined(entries[0], "Signal command mention history entry").body).toBe(
      "/help @other-user",
    );
  });

  it("does not accept malformed matching native mention metadata as a bot mention", async () => {
    const groupHistories = new Map();
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: null,
      accountUuid: "bot-uuid",
      groupHistories,
    });

    await handler(
      makeGroupEvent({
        message: "plain ping",
        mentions: [{ uuid: "bot-uuid", start: 99, length: 1 }],
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = getGroupHistoryEntries(groupHistories);
    expect(entries).toHaveLength(1);
    expect(expectDefined(entries[0], "Signal malformed mention history entry").body).toBe(
      "plain ping",
    );
  });
});

describe("renderSignalMentions", () => {
  const PLACEHOLDER = "\uFFFC";

  it("skips mentions that lack identifiers or out-of-bounds spans", () => {
    const message = `${PLACEHOLDER} hi`;
    const normalized = renderSignalMentions(message, [
      { name: "ignored" },
      { uuid: "valid", start: 0, length: 1 },
      { number: "+1555", start: 999, length: 1 },
    ]);

    expect(normalized).toBe("@valid hi");
  });
});

function requireInternalHookEventCall() {
  const [call] = internalHookMocks.createInternalHookEvent.mock.calls;
  if (!call) {
    throw new Error("expected internal hook event call");
  }
  return call;
}

describe("signal mention-skip silent ingest", () => {
  it("emits internal message:received when ingest is enabled", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            groupChat: { mentionPatterns: ["@bot"] },
          },
          channels: {
            signal: {
              groups: {
                "*": {
                  requireMention: true,
                  ingest: true,
                },
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

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    const [type, action, sessionKey, context] = requireInternalHookEventCall();
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
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            groupChat: { mentionPatterns: ["@bot"] },
          },
          channels: {
            signal: {
              groups: {
                "group-123": {
                  requireMention: true,
                  ingest: false,
                },
                "*": {
                  requireMention: true,
                  ingest: true,
                },
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

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });
});
