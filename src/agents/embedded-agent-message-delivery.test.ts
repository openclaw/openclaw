import { describe, expect, it } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../channels/message/receipt.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import {
  projectEmbeddedMessageDeliveryFact,
  projectPluginMessageDeliveryFact,
  readEmbeddedMessageDeliveryFact,
} from "./embedded-agent-message-delivery.js";

describe("projectEmbeddedMessageDeliveryFact", () => {
  it.each([
    ["nonarray", "thread", undefined],
    ["mixed", ["thread", 1], undefined],
    ["sparse", Object.assign([], { length: 1 }), undefined],
    ["raw strings", ["", " thread ", "thread", "thread"], ["", " thread ", "thread", "thread"]],
  ])("validates the complete delivery thread list: %s", (_label, createdThreadIds, expected) => {
    const fact = readEmbeddedMessageDeliveryFact({
      status: "settled",
      partialDelivery: false,
      createdThreadIds,
    });
    expect(fact?.createdThreadIds).toEqual(expected);
  });

  it.each([
    [{ dryRun: true, sentBeforeError: true }, "dryRun", false],
    [{ sentBeforeError: true, messageId: "suppressed" }, "settled", true],
    [{ messageId: "suppressed", error: "no delivery" }, "suppressed", false],
    [{ changed: false, messageId: "sent-1" }, "failed", false],
    [{ error: "no delivery", messageId: "sent-1" }, "failed", false],
  ])("preserves nested plugin signal precedence: %j", (signals, status, partialDelivery) => {
    expect(
      projectPluginMessageDeliveryFact({
        content: [{ text: JSON.stringify({ result: signals }) }],
      }),
    ).toEqual({ status, partialDelivery, createdThreadIds: [] });
  });

  it("projects identities from parsed plugin envelopes in traversal order", () => {
    expect(
      projectPluginMessageDeliveryFact({
        content: [{ text: '{"result":{"messageId":" first ","channelId":"channel-1"}}' }],
        payload: { pollId: "second", roomId: "room-2" },
      }),
    ).toEqual({
      status: "settled",
      primaryPlatformMessageId: "first",
      deliveredTargets: ["channel-1", "room-2"],
      partialDelivery: false,
      createdThreadIds: [],
    });
  });

  it.each([
    { status: "settled", partialDelivery: false, sourceReplyDelivered: true, expected: true },
    { status: "settled", partialDelivery: true, sourceReplyDelivered: true },
    { status: "dryRun", partialDelivery: false, sourceReplyDelivered: true },
    { status: "failed", partialDelivery: false, sourceReplyDelivered: true },
    { status: "settled", partialDelivery: false, sourceReplyDelivered: "true" },
  ])("reads only confirmed final source delivery: %j", ({ expected, ...fact }) => {
    expect(
      readEmbeddedMessageDeliveryFact({ ...fact, createdThreadIds: [] })?.sourceReplyDelivered,
    ).toBe(expected);
  });
  it("projects canonical poll receipt identity and thread facts", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ messageId: "platform-poll-1" }],
      kind: "poll",
      threadId: "thread-1",
      sentAt: 1,
    });
    const result = {
      kind: "poll",
      channel: "discord",
      action: "poll",
      to: "channel:parent-1",
      handledBy: "core",
      payload: {},
      pollResult: {
        channel: "discord",
        to: "channel:parent-1",
        question: "Ship it?",
        options: ["Yes", "No"],
        maxSelections: 1,
        durationSeconds: null,
        durationHours: 24,
        via: "direct",
        result: { messageId: "legacy-poll-1", receipt },
      },
      dryRun: false,
    } satisfies MessageActionResult;

    expect(projectEmbeddedMessageDeliveryFact(result)).toEqual({
      status: "settled",
      primaryPlatformMessageId: "platform-poll-1",
      partialDelivery: false,
      createdThreadIds: ["thread-1"],
    });
  });
});
