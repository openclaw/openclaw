import { beforeEach, describe, expect, it } from "vitest";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import type { MessageSendResult } from "../infra/outbound/message.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { projectEmbeddedMessageDeliveryFact } from "./embedded-agent-message-delivery.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
  readMessageToolSourceReplyText,
} from "./embedded-agent-message-tool-source-reply.js";
import {
  isMessagingToolDeliveryAction,
  isMessagingToolSendAction,
  isMessagingToolTargetEvidenceAction,
} from "./embedded-agent-messaging.js";

function expectMessagingDelivery(input: Parameters<typeof isDeliveredMessagingToolResult>[0]) {
  return expect(isDeliveredMessagingToolResult(input));
}

function expectSourceReplyDelivery(
  input: Omit<Parameters<typeof isDeliveredMessageToolOnlySourceReplyResult>[0], "toolName">,
) {
  return expect(
    isDeliveredMessageToolOnlySourceReplyResult({
      sourceReplyDeliveryMode: "message_tool_only",
      toolName: "message",
      ...input,
    }),
  );
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "native-messaging",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "native-messaging" }),
          actions: {
            describeMessageTool: () => null,
            isToolDeliveryAction: ({ args }: { args: Record<string, unknown> }) =>
              args.action === "editMessage" || args.action === "deleteMessage",
          },
        },
      },
    ]),
  );
});

describe("messaging delivery action classification", () => {
  it.each([
    ["conversations_send", {}, true, true, true],
    ["conversations_turn", {}, true, true, true],
    ["message", { action: "poll" }, false, true, true],
    ["message", { action: "threadCreate" }, false, true, true],
    ["message", { action: "edit" }, false, false, true],
    ["message", { action: "read" }, false, false, false],
    ["native-messaging", { action: "editMessage" }, false, false, true],
    ["native-messaging", { action: "deleteMessage" }, false, false, true],
    ["native-messaging", { action: "readMessages" }, false, false, false],
  ] as const)("%s %j send=%s target=%s delivery=%s", (tool, args, send, target, delivery) => {
    expect([
      isMessagingToolSendAction(tool, args),
      isMessagingToolTargetEvidenceAction(tool, args),
      isMessagingToolDeliveryAction(tool, args),
    ]).toEqual([send, target, delivery]);
  });
});

describe("isDeliveredMessagingToolResult", () => {
  it.each(["sessions_send", "conversations_list", "exec"])(
    "does not infer external delivery for %s from plugin-shaped success",
    (toolName) => {
      expectMessagingDelivery({
        toolName,
        args: { action: "send" },
        result: { details: { status: "sent", messageId: "operation-1" } },
      }).toBe(false);
    },
  );

  it.each(["queued", "suppressed", "unknown"])(
    "keeps a core %s receipt authoritative over plugin-shaped hook evidence",
    (status) => {
      expectMessagingDelivery({
        toolName: "conversations_send",
        result: { details: { status, messageId: "prepared-id" } },
        hookResult: { details: { status: "sent", messageId: "hook-id" } },
      }).toBe(false);
    },
  );

  it.each([
    ["sent status", { deliveryStatus: "sent" }, true],
    ["unknown id", { result: { messageId: "unknown" } }, true],
    ["skipped id", { result: { messageId: "skipped" } }, false],
    ["suppressed id", { result: { messageId: "suppressed" } }, false],
    ["suppressed status", { deliveryStatus: "suppressed" }, false],
    ["dry run", { dryRun: true }, false],
    ["partial status", { deliveryStatus: "partial_failed" }, true],
    ["partial marker", { sentBeforeError: true }, true],
    ["failed status", { deliveryStatus: "failed" }, false],
    [
      "receipt id",
      {
        result: {
          channel: "telegram",
          messageId: "",
          receipt: {
            primaryPlatformMessageId: "receipt-1",
            platformMessageIds: ["receipt-1"],
            parts: [],
            sentAt: 1,
          },
        },
      },
      true,
    ],
  ] satisfies Array<[string, Partial<MessageSendResult>, boolean]>)(
    "preserves the differential core-send verdict for $0",
    (_name, partial, expected) => {
      const sendResult: MessageSendResult = {
        channel: "telegram",
        to: "chat-1",
        via: "direct",
        mediaUrl: null,
        ...partial,
      };
      const actionResult: MessageActionResult = {
        kind: "send",
        channel: "telegram",
        action: "send",
        to: "chat-1",
        handledBy: "core",
        payload: sendResult,
        sendResult,
        dryRun: sendResult.dryRun === true,
      };
      const fact = projectEmbeddedMessageDeliveryFact(actionResult);

      expect(fact?.status === "settled").toBe(expected);
    },
  );

  it.each([
    [
      "provider message id",
      { ok: true, payload: { ok: true, messageId: "plugin-message-1" } },
      true,
    ],
    ["provider bare ok", { ok: true, payload: { ok: true, to: "spaces/AAA" } }, true],
    [
      "provider suppressed status",
      { ok: true, payload: { ok: true, status: "suppressed" } },
      false,
    ],
    ["provider no-op marker", { ok: true, payload: { ok: true, changed: false } }, false],
    [
      "provider failure with an attempt id",
      { ok: true, payload: { ok: false, error: "send failed", messageId: "attempt-id" } },
      false,
    ],
    [
      "provider failure after partial delivery",
      {
        ok: true,
        payload: {
          ok: false,
          error: "second attachment failed",
          messageId: "partial-receipt-1",
          sentBeforeError: true,
        },
      },
      true,
    ],
    ["missing provider payload", { ok: true }, false],
    ["failed entry after partial delivery", { ok: false, sentBeforeError: true as const }, true],
  ] satisfies Array<[string, Record<string, unknown>, boolean]>)(
    "preserves the differential payload-only broadcast verdict for $0",
    (_name, entry, expected) => {
      const actionResult: MessageActionResult = {
        kind: "broadcast",
        channel: "googlechat",
        action: "broadcast",
        handledBy: "core",
        payload: {
          results: [{ channel: "googlechat", to: "space-1", ...entry }],
        },
        dryRun: false,
      };

      expect(projectEmbeddedMessageDeliveryFact(actionResult)?.status === "settled").toBe(expected);
      expectMessagingDelivery({
        args: { action: "broadcast" },
        result: actionResult.payload,
      }).toBe(expected);
    },
  );

  const textBlock = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];
  const entry = (payload?: unknown, ok = true) => ({
    channel: "googlechat",
    to: "space-1",
    ok,
    ...(payload === undefined ? {} : { payload }),
  });
  const receipt = { result: { messageId: "msg-1" } };
  type DeliveryInput = Parameters<typeof isDeliveredMessagingToolResult>[0];
  type DeliveryCase = [
    string,
    unknown,
    boolean,
    (string | Record<string, unknown>)?,
    DeliveryInput?,
  ];

  it.each<DeliveryCase>([
    ["CLI receipt", textBlock(receipt), true],
    ["text receipt", { content: [{ text: "sent" }] }, true],
    ["sent status", { status: "sent" }, true],
    ["bare poll success", { ok: true }, true, "poll"],
    ["sticker text success", textBlock({ ok: true }), true, "sticker"],
    ["channel creation", { ok: true }, true, "channel-create"],
    ["null removal", { ok: true, removed: null }, false, "react"],
    ["zero removal", { ok: true, removed: 0 }, false, "react"],
    ["empty removal", { ok: true, removed: [] }, false, "react"],
    ["unchanged reaction", { ok: true, changed: false }, false, "react"],
    [
      "details override text",
      { content: [{ text: "sent" }], details: { sent: false } },
      false,
      "react",
    ],
    ["poll identifier", { pollId: "poll-1" }, true],
    ["thread receipt", { ok: true, thread: { id: "thread-1" } }, true, "thread-create"],
    ["topic receipt", { ok: true, topicId: 42 }, true, "topic-create"],
    [
      "topic metadata error",
      { topicId: 43, error: "post-create metadata update failed" },
      true,
      "topic-create",
      { isError: true },
    ],
    [
      "partial broadcast",
      {
        results: [
          {
            channel: "telegram",
            to: "chat-1",
            ok: true,
            payload: { ok: true, messageId: "gateway-message-1" },
          },
          {
            channel: "googlechat",
            to: "space-2",
            ok: false,
            payload: { ok: false, error: "send failed" },
          },
        ],
      },
      true,
      "broadcast",
    ],
    ["broadcast without evidence", { results: [entry()] }, false, "broadcast"],
    [
      "broadcast destination",
      { results: [entry({ ok: true, to: "spaces/AAA" })] },
      true,
      "broadcast",
    ],
    ...(["suppressed", "dry_run", "failed", "sent", "partial_failed"] as const).map(
      (deliveryStatus): DeliveryCase => [
        `deliveryStatus ${deliveryStatus}`,
        { ok: true, deliveryStatus },
        deliveryStatus === "sent" || deliveryStatus === "partial_failed",
        { action: "send", to: "channel-1" },
        { toolName: "message" },
      ],
    ),
    ["skipped identifier", { messageId: "skipped" }, false],
    ["suppressed identifier", { messageId: "suppressed" }, false],
    ["unknown identifier", { messageId: "unknown" }, true],
    ["dry-run arguments", receipt, false, { dryRun: true }],
    ["suppressed status", { status: "suppressed" }, false],
    ["errored receipt", receipt, false, undefined, { isError: true }],
    [
      "partial delivery before error",
      Object.assign(new Error("second chunk failed"), { sentBeforeError: true }),
      true,
      undefined,
      { isError: true },
    ],
    [
      "nested provider receipt",
      {
        content: textBlock({ message: { id: "qa-message-242" } }),
        details: { message: { id: "qa-message-242" } },
      },
      true,
      { action: "send", channel: "qa-channel", target: "qa-a2a-requester", message: "reply" },
      { toolName: "message" },
    ],
  ])("%s", (_name, result, expected, routing, extra) => {
    const args = typeof routing === "string" ? { action: routing } : routing;
    expectMessagingDelivery({ result, args, ...extra }).toBe(expected);
  });
});

describe("isDeliveredMessageToolOnlySourceReplyResult", () => {
  const send = { action: "send", message: "reply" };
  const explicit = {
    action: "reply",
    channel: "imessage",
    target: "+12069106512",
    message: "reply",
  };
  const poll = { action: "poll", pollQuestion: "Preferred default?", pollOption: ["a", "b"] };
  const receipt = { ok: true, messageId: "imessage-853" };
  const sent = { deliveryStatus: "sent" };
  const confirmed = (fields: Record<string, unknown>) => ({
    details: { ...fields, sourceReplyRoute: "current-source" },
  });
  type Input = Parameters<typeof expectSourceReplyDelivery>[0];
  type Case = [string, unknown, unknown, boolean, Omit<Input, "args" | "result">?];
  it.each<Case>([
    ["confirmed poll", poll, confirmed({ ok: true, pollId: "poll-1" }), true],
    ["unconfirmed poll", poll, { details: { ok: true, pollId: "poll-1" } }, false],
    ["implicit send", send, sent, true, { deliveryConfirmed: true }],
    [
      "unverified target",
      { ...send, target: "elsewhere" },
      sent,
      false,
      { deliveryConfirmed: true },
    ],
    [
      "verified explicit route",
      explicit,
      receipt,
      true,
      { sourceReplyDeliveryMode: "automatic", allowExplicitSourceRoute: true },
    ],
    [
      "unverified explicit route",
      explicit,
      receipt,
      false,
      { sourceReplyDeliveryMode: "automatic" },
    ],
    [
      "reaction is not a reply",
      { ...explicit, action: "react" },
      { ok: true },
      false,
      { sourceReplyDeliveryMode: "automatic", allowExplicitSourceRoute: true },
    ],
    [
      "structured current-source marker",
      { ...send, channel: "telegram", target: "8455538490" },
      {
        content: [{ type: "text", text: '{"ok":true}' }],
        ...confirmed({ ok: true, messageId: "telegram-242" }),
      },
      true,
    ],
    [
      "untrusted marker in text",
      { ...send, target: "elsewhere" },
      {
        content: [{ type: "text", text: '{"ok":true,"sourceReplyRoute":"current-source"}' }],
        details: { ok: true, messageId: "remote-242" },
      },
      false,
    ],
  ])("%s", (_name, args, result, expected, options) => {
    expectSourceReplyDelivery({ args, result, ...options }).toBe(expected);
  });
});

describe("readMessageToolSourceReplyText", () => {
  it.each([
    {
      name: "reply",
      args: { action: "reply", message: "Visible reply" },
      expected: "Visible reply",
    },
    {
      name: "thread reply",
      args: { action: "thread-reply", text: "Visible thread reply" },
      expected: "Visible thread reply",
    },
    {
      name: "poll",
      args: { action: "poll", pollQuestion: "Preferred default?" },
      expected: "Preferred default?",
    },
    {
      name: "snake-case poll",
      args: { action: "poll", poll_question: "Ready?" },
      expected: "Ready?",
    },
  ])("reads $name visible text", ({ args, expected }) => {
    expect(readMessageToolSourceReplyText(args)).toBe(expected);
  });

  it("ignores non-source-reply actions", () => {
    expect(readMessageToolSourceReplyText({ action: "react", message: "not a reply" })).toBe(
      undefined,
    );
  });
});
