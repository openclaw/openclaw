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

const textBlocks = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];
const broadcast = (...entries: Record<string, unknown>[]) => ({
  results: entries.map((entry) => Object.assign({ channel: "googlechat", to: "space-1" }, entry)),
});
const pollArgs = { action: "poll", pollQuestion: "Preferred default?", pollOption: ["a", "b"] };
const explicitRoute = { channel: "imessage", target: "+12069106512" };

function expectDelivery(
  expected: boolean,
  result: unknown,
  args: unknown = {},
  options: Omit<Parameters<typeof isDeliveredMessagingToolResult>[0], "result" | "args"> = {},
) {
  expect(isDeliveredMessagingToolResult({ result, args, ...options })).toBe(expected);
}
function expectSourceReply(
  expected: boolean,
  args: unknown,
  result: unknown,
  options: Omit<
    Parameters<typeof isDeliveredMessageToolOnlySourceReplyResult>[0],
    "args" | "result" | "toolName"
  > = {},
) {
  expect(
    isDeliveredMessageToolOnlySourceReplyResult({
      sourceReplyDeliveryMode: "message_tool_only",
      toolName: "message",
      args,
      result,
      ...options,
    }),
  ).toBe(expected);
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
  it("classifies exact conversation sends as visible messaging delivery", () => {
    for (const toolName of ["conversations_send", "conversations_turn"]) {
      expect(isMessagingToolSendAction(toolName, {})).toBe(true);
      expect(isMessagingToolTargetEvidenceAction(toolName, {})).toBe(true);
      expect(isMessagingToolDeliveryAction(toolName, {})).toBe(true);
    }
  });

  it("keeps visible side effects broader than terminal reply sends", () => {
    expect(isMessagingToolSendAction("message", { action: "poll" })).toBe(false);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "poll" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "reply" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "sticker" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "thread-create" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "topic-create" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "threadCreate" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "createForumTopic" })).toBe(
      true,
    );
    expect(isMessagingToolTargetEvidenceAction("message", { action: "edit" })).toBe(false);
    expect(isMessagingToolDeliveryAction("message", { action: "poll" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "broadcast" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "thread-create" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "topic-create" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "createForumTopic" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "channel-create" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "event-create" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "react" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "read" })).toBe(false);
    expect(isMessagingToolDeliveryAction("message", { action: "channel-list" })).toBe(false);
  });

  it("uses provider-native mutation contracts", () => {
    expect(isMessagingToolDeliveryAction("native-messaging", { action: "editMessage" })).toBe(true);
    expect(isMessagingToolDeliveryAction("native-messaging", { action: "deleteMessage" })).toBe(
      true,
    );
    expect(isMessagingToolDeliveryAction("native-messaging", { action: "readMessages" })).toBe(
      false,
    );
  });
});

describe("isDeliveredMessagingToolResult", () => {
  it.each(["sessions_send", "conversations_list", "exec"])(
    "does not infer external delivery for %s from plugin-shaped success",
    (toolName) => {
      expectDelivery(
        false,
        { details: { status: "sent", messageId: "operation-1" } },
        { action: "send" },
        { toolName },
      );
    },
  );

  it.each(["queued", "suppressed", "unknown"])(
    "keeps a core %s receipt authoritative over plugin-shaped hook evidence",
    (status) => {
      expectDelivery(
        false,
        { details: { status, messageId: "prepared-id" } },
        {},
        {
          toolName: "conversations_send",
          hookResult: { details: { status: "sent", messageId: "hook-id" } },
        },
      );
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
        payload: broadcast(entry),
        dryRun: false,
      };

      expect(projectEmbeddedMessageDeliveryFact(actionResult)?.status === "settled").toBe(expected);
      expectDelivery(expected, actionResult.payload, { action: "broadcast" });
    },
  );

  it("accepts confirmed delivery receipts from direct CLI text blocks", () => {
    expectDelivery(true, textBlocks({ result: { messageId: "msg-1" } }));
    expectDelivery(true, { content: [{ text: "sent" }] });
    expectDelivery(true, { status: "sent" });
  });

  it("accepts action-specific bare success delivery contracts", () => {
    expectDelivery(true, { ok: true }, { action: "poll" });
    expectDelivery(true, textBlocks({ ok: true }), { action: "sticker" });
    expectDelivery(true, { ok: true }, { action: "channel-create" });
  });
  it("rejects successful no-op mutation results", () => {
    for (const result of [
      { ok: true, removed: null },
      { ok: true, removed: 0 },
      { ok: true, removed: [] },
      { ok: true, changed: false },
      { content: [{ text: "sent" }], details: { sent: false } },
    ]) {
      expectDelivery(false, result, { action: "react" });
    }
  });

  it("accepts poll delivery identifiers", () => {
    expect(isDeliveredMessagingToolResult({ result: { pollId: "poll-1" } })).toBe(true);
  });

  it("accepts successful thread and topic creation receipts", () => {
    expectDelivery(true, { ok: true, thread: { id: "thread-1" } }, { action: "thread-create" });
    expectDelivery(true, { ok: true, topicId: 42 }, { action: "topic-create" });
    expectDelivery(
      true,
      { topicId: 43, error: "post-create metadata update failed" },
      { action: "topic-create" },
      { isError: true },
    );
  });

  it("accepts only broadcast result entries with concrete delivery evidence", () => {
    expectDelivery(
      true,
      broadcast(
        {
          channel: "telegram",
          to: "chat-1",
          ok: true,
          payload: { ok: true, messageId: "gateway-message-1" },
        },
        { to: "space-2", ok: false, payload: { ok: false, error: "send failed" } },
      ),
      { action: "broadcast" },
    );
    expectDelivery(false, broadcast({ ok: true }), { action: "broadcast" });
    expectDelivery(true, broadcast({ ok: true, payload: { ok: true, to: "spaces/AAA" } }), {
      action: "broadcast",
    });
  });

  it.each([
    ["suppressed", false],
    ["dry_run", false],
    ["failed", false],
    ["sent", true],
    ["partial_failed", true],
  ] as const)("maps plugin deliveryStatus %s to delivered=%s", (deliveryStatus, delivered) => {
    expect(
      isDeliveredMessagingToolResult({
        toolName: "message",
        args: { action: "send", to: "channel-1" },
        result: { ok: true, deliveryStatus },
      }),
    ).toBe(delivered);
  });

  it("rejects non-delivery message id sentinels", () => {
    expect(isDeliveredMessagingToolResult({ result: { messageId: "skipped" } })).toBe(false);
    expect(isDeliveredMessagingToolResult({ result: { messageId: "suppressed" } })).toBe(false);
  });

  it("accepts successful sends with an unknown message id", () => {
    expect(isDeliveredMessagingToolResult({ result: { messageId: "unknown" } })).toBe(true);
  });

  it("rejects dry-run, suppressed, and errored results", () => {
    expectDelivery(false, { result: { messageId: "msg-1" } }, { dryRun: true });
    expectDelivery(false, { status: "suppressed" });
    expectDelivery(false, { result: { messageId: "msg-1" } }, {}, { isError: true });
  });

  it("accepts errored results that prove partial visible delivery", () => {
    expect(
      isDeliveredMessagingToolResult({
        isError: true,
        result: Object.assign(new Error("second chunk failed"), { sentBeforeError: true }),
      }),
    ).toBe(true);
  });

  it("accepts a nested provider message id as delivery evidence", () => {
    expectDelivery(
      true,
      {
        content: textBlocks({ message: { id: "qa-message-242" } }),
        details: { message: { id: "qa-message-242" } },
      },
      {
        action: "send",
        channel: "qa-channel",
        target: "qa-a2a-requester",
        message: "reply",
      },
      { toolName: "message" },
    );
  });
});

describe("isDeliveredMessageToolOnlySourceReplyResult", () => {
  it("accepts a confirmed adopted-thread reply outside message-tool-only mode", () => {
    expectSourceReply(
      true,
      { action: "thread-reply", threadId: "thread-1", message: "done" },
      { details: { ok: true, sourceReplyRoute: "current-source" } },
      { sourceReplyDeliveryMode: "automatic" },
    );
  });

  it("accepts a confirmed current-source poll delivery", () => {
    expectSourceReply(true, pollArgs, {
      details: { ok: true, pollId: "poll-1", sourceReplyRoute: "current-source" },
    });
  });

  it("rejects an unconfirmed poll delivery", () => {
    expectSourceReply(false, pollArgs, { details: { ok: true, pollId: "poll-1" } });
  });

  it("accepts only confirmed implicit message sends", () => {
    expectSourceReply(
      true,
      { action: "send", message: "reply" },
      { deliveryStatus: "sent" },
      { deliveryConfirmed: true },
    );
    expectSourceReply(
      false,
      { action: "send", target: "elsewhere", message: "reply" },
      { deliveryStatus: "sent" },
      { deliveryConfirmed: true },
    );
  });

  it("accepts confirmed explicit routes when the caller verified the source route", () => {
    const reply = { ...explicitRoute, action: "reply", message: "reply" };
    const result = { ok: true, messageId: "imessage-853" };
    const verified = {
      sourceReplyDeliveryMode: "automatic",
      allowExplicitSourceRoute: true,
    } as const;
    expectSourceReply(true, reply, result, verified);
    expectSourceReply(false, reply, result, { sourceReplyDeliveryMode: "automatic" });
    expectSourceReply(false, { ...explicitRoute, action: "react" }, { ok: true }, verified);
  });

  it("accepts explicit sends with a structured current-source marker", () => {
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "8455538490",
          message: "reply",
        },
        result: {
          content: [{ type: "text", text: '{"ok":true}' }],
          details: {
            ok: true,
            messageId: "telegram-242",
            sourceReplyRoute: "current-source",
          },
        },
      }),
    ).toBe(true);
  });

  it("does not trust current-source markers echoed in result text", () => {
    expectSourceReply(
      false,
      { action: "send", target: "elsewhere", message: "reply" },
      {
        content: textBlocks({ ok: true, sourceReplyRoute: "current-source" }),
        details: { ok: true, messageId: "remote-242" },
      },
    );
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
