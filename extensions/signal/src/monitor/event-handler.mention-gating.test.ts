import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { formatSignalMediaText } from "../media-text.js";
import type { SignalDataMessage, SignalEventHandlerDeps } from "./event-handler.types.js";

const hooks = vi.hoisted(() => ({
  trigger: vi.fn(async () => undefined),
}));
vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    triggerInternalHook: hooks.trigger,
  };
});

let capturedCtx: MsgContext | undefined;
const groupHistories: SignalEventHandlerDeps["groupHistories"] = new Map();
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
  { resolveSignalReplyContextWithPersistence },
] = await Promise.all([
  import("./event-handler.test-harness.js"),
  import("./event-handler.js"),
  import("../reply-authors.js"),
]);

function groupEvent(
  message: string,
  data: Partial<SignalDataMessage> = {},
  envelope: Record<string, unknown> = {},
) {
  return createSignalReceiveEvent({
    dataMessage: {
      message,
      attachments: [],
      groupInfo: { groupId: "g1", groupName: "Test Group" },
      ...data,
    },
    ...envelope,
  });
}
function createMentionHandler(
  deps: Partial<SignalEventHandlerDeps> = {},
  mentionPatterns = ["@bot"],
  groups: NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]>["groups"] = {
    "*": { requireMention: true },
  },
) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: {
        messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns } },
        channels: {
          signal: { groups, groupPolicy: deps.groupPolicy, groupAllowFrom: deps.groupAllowFrom },
        },
      },
      groupHistories,
      ...deps,
    }),
  );
}
const storedReply = (replyToId: string) =>
  resolveSignalReplyContextWithPersistence({
    accountId: "default",
    to: "group:g1",
    replyToId,
  });

async function expectSkippedGroupHistory(
  event: ReturnType<typeof groupEvent>,
  expectedBody: string,
  expectedMediaText = "",
  mentionOptions: Partial<SignalEventHandlerDeps> = {},
  patterns = ["@bot"],
) {
  const handler = createMentionHandler(mentionOptions, patterns);
  await handler(event);
  expect(capturedCtx).toBeUndefined();
  const entries = groupHistories.get("g1");
  expect(entries).toHaveLength(1);
  expect(entries?.[0]?.body).toBe(expectedBody);
  expect(formatSignalMediaText(entries?.[0]?.media ?? [])).toBe(expectedMediaText);
}

beforeEach(() => {
  capturedCtx = undefined;
  groupHistories.clear();
});

it("logs identity-derived mention drops once per account and group while preserving history", async () => {
  const log = vi.fn();
  const createHandler = (accountId: string) =>
    createMentionHandler({
      accountId,
      runtime: { log, error: vi.fn(), exit: vi.fn() },
      groupHistories,
      cfg: { agents: { entries: { main: { identity: { name: "Claw" } } } } },
    });
  const event = (groupId: string) => groupEvent("What up", { groupInfo: { groupId } });
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
  expect(log.mock.calls.flat().join(" ")).not.toMatch(/What up|\+15550001111/);
});

it("allows explicitly configured Signal groups by group id without a mention", async () => {
  const handler = createMentionHandler(
    {
      groupPolicy: "allowlist",
      groupAllowFrom: ["group:g1"],
    },
    ["@bot"],
    { g1: {} },
  );

  await handler(groupEvent("hello everyone"));
  expect(getCapturedCtx().WasMentioned).toBe(false);
});

it("records edited target reply authors for skipped group messages", async () => {
  const handler = createMentionHandler();

  await handler(
    createSignalReceiveEvent({
      timestamp: 1700000000999,
      editMessage: {
        targetSentTimestamp: 1700000000000,
        dataMessage: {
          timestamp: 1700000000999,
          message: "edited without mention",
          groupInfo: { groupId: "g1" },
        },
      },
    }),
  );

  expect(capturedCtx).toBeUndefined();
  await expect(storedReply("1700000000000")).resolves.toEqual({
    author: "+15550001111",
    body: "edited without mention",
  });
});

it("records a structured fact for skipped attachment-only group messages", async () => {
  await expectSkippedGroupHistory(
    groupEvent("", { attachments: [{ id: "a1" }] }, { timestamp: 1700000000123 }),
    "",
    "<media:attachment>",
  );
  await expect(storedReply("1700000000123")).resolves.toEqual({
    author: "+15550001111",
    media: [{ contentType: undefined, kind: "unknown" }],
  });
});

it("summarizes multiple skipped attachments with stable file count wording", async () => {
  await expectSkippedGroupHistory(
    groupEvent("", { attachments: [{ id: "a1" }, { id: "a2" }] }),
    "",
    "[2 files attached]",
  );
});

it("records quote text in pending history for skipped quote-only group messages", async () => {
  await expectSkippedGroupHistory(
    groupEvent("", { quote: { text: "quoted context" } }),
    "quoted context",
  );
});

it.each([
  [{ accountUuid: "bot-uuid" }, "Hi X!", { uuid: "bot-uuid", start: 3, length: 1 }, "Hi X!"],
  [
    { account: "+15550002222" },
    "please \uFFFC",
    { number: "1 (555) 000-2222", start: 7, length: 1 },
    "please @1 (555) 000-2222",
  ],
] as const)("allows native bot mentions: %j", async (account, message, mention, body) => {
  const handler = createMentionHandler(account, []);
  await handler(
    groupEvent(message, {
      mentions: [{ name: "ignored" }, mention, { number: "+1555", start: 999, length: 1 }],
    }),
  );
  expect(getCapturedCtx()).toMatchObject({
    Body: expect.stringContaining(body),
    CommandBody: body,
    WasMentioned: true,
  });
});

it.each([
  ["/help \uFFFC", { uuid: "other-user", start: 6, length: 1 }, "/help @other-user"],
  ["plain ping", { uuid: "bot-uuid", start: 99, length: 1 }, "plain ping"],
] as const)(
  "rejects a non-bot or malformed native mention: %s",
  async (message, mention, expected) => {
    await expectSkippedGroupHistory(
      groupEvent(message, { mentions: [mention] }),
      expected,
      "",
      {
        accountUuid: "bot-uuid",
      },
      [],
    );
  },
);
it.each([false, true])("mention-skip ingest honors group override=%s", async (overrideGroup) => {
  hooks.trigger.mockClear();
  const handler = createMentionHandler({}, ["@bot"], {
    "*": { requireMention: true, ingest: true },
    ...(overrideGroup ? { "group-123": { requireMention: true, ingest: false } } : {}),
  });
  await handler(
    groupEvent("hello without mention", {
      groupInfo: { groupId: "group-123", groupName: "Ops" },
    }),
  );
  if (overrideGroup) {
    expect(hooks.trigger).not.toHaveBeenCalled();
  } else {
    expect(hooks.trigger).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "message",
        action: "received",
        sessionKey: expect.stringContaining("signal"),
        context: expect.objectContaining({
          content: "hello without mention",
          channelId: "signal",
          conversationId: "group:group-123",
        }),
      }),
    );
  }
});
