import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatSignalMediaText } from "../media-text.js";
import type { SignalDataMessage, SignalEventHandlerDeps } from "./event-handler.types.js";

const hooks = vi.hoisted(() => ({
  create: vi.fn<typeof import("openclaw/plugin-sdk/hook-runtime").createInternalHookEvent>(),
  trigger: vi.fn(async () => undefined),
}));
vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    createInternalHookEvent: hooks.create.mockImplementation(actual.createInternalHookEvent),
    triggerInternalHook: hooks.trigger,
  };
});

let capturedCtx: MsgContext | undefined;
const getCapturedCtx = () => expectDefined(capturedCtx, "Signal MsgContext");

// mock-isolation: Shared helper preserves real exports while isolating worker-backed dispatch.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const { signalInboundTestModule } =
    await import("./event-handler.inbound-context.test-support.js");
  return signalInboundTestModule(
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>(),
    async () => {},
    async (resolved) => {
      capturedCtx = resolved.ctxPayload;
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
    false,
  );
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

type GroupEventOpts = Pick<
  SignalDataMessage,
  "message" | "attachments" | "mentions" | "groupInfo"
> & {
  quoteText?: string;
  timestamp?: number;
  editTarget?: number;
};
function makeGroupEvent(opts: GroupEventOpts) {
  const dataMessage = {
    message: opts.message ?? "",
    attachments: opts.attachments ?? [],
    quote: opts.quoteText ? { text: opts.quoteText } : undefined,
    mentions: opts.mentions ?? undefined,
    groupInfo: opts.groupInfo ?? { groupId: "g1", groupName: "Test Group" },
  };
  return createSignalReceiveEvent({
    ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
    ...(opts.editTarget === undefined
      ? { dataMessage }
      : {
          editMessage: {
            targetSentTimestamp: opts.editTarget,
            dataMessage: { ...dataMessage, timestamp: opts.timestamp },
          },
        }),
  });
}
function createMentionHandler({
  mentionPattern,
  ...deps
}: Partial<
  Pick<SignalEventHandlerDeps, "historyLimit" | "groupHistories" | "account" | "accountUuid">
> & {
  mentionPattern?: string | null;
} = {}) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: groupConfig(
        { "*": { requireMention: true } },
        mentionPattern === null ? [] : [mentionPattern ?? "@bot"],
      ),
      ...deps,
    }),
  );
}
async function expectStoredReply(replyToId: string, expected: unknown) {
  await expect(
    resolveSignalReplyContextWithPersistence({
      accountId: "default",
      to: "group:g1",
      replyToId,
    }),
  ).resolves.toEqual(expected);
}

function groupConfig(
  groups: NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]>["groups"],
  mentionPatterns = ["@bot"],
  signal: NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]> = {},
): OpenClawConfig {
  return {
    messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns } },
    channels: { signal: { groups, ...signal } },
  };
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
    historyLimit: 5,
    groupHistories,
    ...mentionOptions,
  });
  await handler(makeGroupEvent(opts));
  expect(capturedCtx).toBeUndefined();
  const entries = expectDefined(groupHistories.get("g1"), "pending group history");
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
        cfg: groupConfig({ g1: {} }, ["@bot"], {
          groupPolicy: "allowlist",
          groupAllowFrom: ["group:g1"],
        }),
        groupPolicy: "allowlist",
        groupAllowFrom: ["group:g1"],
      }),
    );

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(getCapturedCtx().WasMentioned).toBe(false);
  });

  it("records edited target reply authors for skipped group messages", async () => {
    const handler = createMentionHandler();

    await handler(
      makeGroupEvent({
        timestamp: 1700000000999,
        editTarget: 1700000000000,
        message: "edited without mention",
      }),
    );

    expect(capturedCtx).toBeUndefined();
    await expectStoredReply("1700000000000", {
      author: "+15550001111",
      body: "edited without mention",
    });
  });

  it("records a structured fact for skipped attachment-only group messages", async () => {
    await expectSkippedGroupHistory(
      { message: "", attachments: [{ id: "a1" }], timestamp: 1700000000123 },
      "",
      "<media:attachment>",
    );
    await expectStoredReply("1700000000123", {
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
      mentionPattern: null,
      ...account,
    });
    await handler(makeGroupEvent({ message, mentions: [mention] }));
    expect(getCapturedCtx()).toMatchObject({
      Body: expect.stringContaining(body),
      WasMentioned: true,
    });
  });

  it.each([
    ["/help \uFFFC", { uuid: "other-user", start: 6, length: 1 }, "/help @other-user"],
    ["plain ping", { uuid: "bot-uuid", start: 99, length: 1 }, "plain ping"],
  ] as const)(
    "rejects a non-bot or malformed native mention: %s",
    async (message, mention, expected) => {
      await expectSkippedGroupHistory({ message, mentions: [mention] }, expected, "", {
        mentionPattern: null,
        accountUuid: "bot-uuid",
      });
    },
  );
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
  hooks.create.mockClear();
  hooks.trigger.mockClear();
  const handler = createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: groupConfig({
        "*": { requireMention: true, ingest: true },
        ...(overrideGroup ? { "group-123": { requireMention: true, ingest: false } } : {}),
      }),
    }),
  );
  await handler(
    makeGroupEvent({
      message: "hello without mention",
      groupInfo: { groupId: "group-123", groupName: "Ops" },
    }),
  );
}

describe("signal mention-skip silent ingest", () => {
  it("emits internal message:received when ingest is enabled", async () => {
    await receiveSilentIngest();
    expect(hooks.create).toHaveBeenCalledTimes(1);
    expect(hooks.create).toHaveBeenCalledWith(
      "message",
      "received",
      expect.stringContaining("signal"),
      {
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
      },
    );
    expect(hooks.trigger).toHaveBeenCalledTimes(1);
  });

  it("does not emit when group ingest is false and wildcard ingest is true", async () => {
    await receiveSilentIngest(true);
    expect(hooks.create).not.toHaveBeenCalled();
    expect(hooks.trigger).not.toHaveBeenCalled();
  });
});
