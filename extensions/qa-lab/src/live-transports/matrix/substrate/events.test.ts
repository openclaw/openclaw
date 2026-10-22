import { describe, expect, it } from "vitest";
import {
  normalizeMatrixQaObservedEvent,
  type MatrixQaObservedEvent,
  type MatrixQaRoomEvent,
} from "./events.js";

const roomId = "!room:matrix-qa.test";
const sender = "@sut:matrix-qa.test";

function message(content: Record<string, unknown>, envelope: Partial<MatrixQaRoomEvent> = {}) {
  return { event_id: "$event", sender, type: "m.room.message", ...envelope, content };
}

function expectEvent(
  content: Record<string, unknown>,
  expected: Partial<MatrixQaObservedEvent>,
  envelope: Partial<MatrixQaRoomEvent> = {},
) {
  expect(normalizeMatrixQaObservedEvent(roomId, message(content, envelope))).toEqual({
    eventId: "$event",
    kind: "message",
    roomId,
    sender,
    type: "m.room.message",
    ...expected,
  });
}

describe("matrix observed event normalization", () => {
  it("normalizes message events with thread metadata", () => {
    expectEvent(
      {
        body: "hello",
        msgtype: "m.text",
        "m.mentions": { user_ids: [sender] },
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$root",
          is_falling_back: true,
          "m.in_reply_to": { event_id: "$driver" },
        },
      },
      {
        originServerTs: 1_700_000_000_000,
        body: "hello",
        msgtype: "m.text",
        relatesTo: {
          relType: "m.thread",
          eventId: "$root",
          inReplyToId: "$driver",
          isFallingBack: true,
        },
        mentions: { userIds: [sender] },
      },
      { origin_server_ts: 1_700_000_000_000 },
    );
  });

  it.each([
    {
      name: "preview edit",
      newContent: { body: "preview", "org.matrix.msc4357.live": {} },
      outerContent: {},
      live: true,
    },
    {
      name: "final edit",
      newContent: { body: "final" },
      outerContent: { "org.matrix.msc4357.live": {} },
      live: undefined,
    },
  ])("preserves the live marker only on $name", ({ newContent, outerContent, live }) => {
    const event = normalizeMatrixQaObservedEvent(roomId, {
      event_id: "$event",
      type: "m.room.message",
      content: {
        body: "preview",
        msgtype: "m.text",
        ...outerContent,
        "m.relates_to": { rel_type: "m.replace", event_id: "$draft" },
        "m.new_content": newContent,
      },
    });
    expect(event?.live).toBe(live);
  });

  it("normalizes Matrix reaction events with target metadata", () => {
    expectEvent(
      {
        "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key: "👍" },
      },
      {
        eventId: "$reaction",
        kind: "reaction",
        sender: "@driver:matrix-qa.test",
        type: "m.reaction",
        originServerTs: 1_700_000_000_000,
        relatesTo: { eventId: "$msg", relType: "m.annotation" },
        reaction: { eventId: "$msg", key: "👍" },
      },
      {
        event_id: "$reaction",
        sender: "@driver:matrix-qa.test",
        type: "m.reaction",
        origin_server_ts: 1_700_000_000_000,
      },
    );
  });

  const approval = {
    allowedDecisions: ["allow-once", "deny"],
    state: "pending",
    type: "approval.request",
    version: 1,
  };
  it.each([
    {
      name: "command presence without a preview of raw approval text",
      eventId: "$approval",
      body: "React here: ✅ Allow once, ❌ Deny",
      metadata: { id: "approval-1", kind: "exec", commandText: "printf " + "A".repeat(300) },
      summary: { id: "approval-1", kind: "exec", hasCommandText: true },
    },
    {
      name: "plugin approval metadata fields",
      eventId: "$plugin-approval",
      body: "Plugin approval required",
      metadata: {
        id: "plugin:approval-1",
        kind: "plugin",
        agentId: "qa",
        pluginId: "qa-plugin",
        severity: "medium",
        toolName: "qa_tool",
      },
      summary: {
        id: "plugin:approval-1",
        kind: "plugin",
        agentId: "qa",
        pluginId: "qa-plugin",
        severity: "medium",
        toolName: "qa_tool",
      },
    },
  ] as const)("summarizes $name", ({ eventId, body, metadata, summary }) => {
    expectEvent(
      {
        body,
        msgtype: "m.text",
        "com.openclaw.approval": { ...structuredClone(approval), ...metadata },
      },
      { eventId, body, msgtype: "m.text", approval: { ...approval, ...summary } },
      { event_id: eventId },
    );
  });

  it.each([
    {
      name: "explicit filename and caption",
      content: {
        body: "Protocol note: generated the QA lighthouse image successfully.",
        filename: "qa-lighthouse.png",
      },
      attachment: {
        kind: "image",
        caption: "Protocol note: generated the QA lighthouse image successfully.",
        filename: "qa-lighthouse.png",
      },
    },
    {
      name: "filename-like body",
      content: { body: "qa-lighthouse.png" },
      attachment: { kind: "image", filename: "qa-lighthouse.png" },
    },
  ] as const)("normalizes image messages with $name", ({ content, attachment }) => {
    expectEvent(
      { ...content, msgtype: "m.image" },
      { eventId: "$image", body: content.body, msgtype: "m.image", attachment },
      { event_id: "$image" },
    );
  });

  it("normalizes membership events with explicit membership kind", () => {
    expectEvent(
      { membership: "leave" },
      {
        eventId: "$membership",
        kind: "membership",
        sender: "@driver:matrix-qa.test",
        stateKey: sender,
        type: "m.room.member",
        membership: "leave",
      },
      {
        event_id: "$membership",
        sender: "@driver:matrix-qa.test",
        state_key: sender,
        type: "m.room.member",
      },
    );
  });

  it("classifies Matrix redactions without needing raw event inspection", () => {
    expectEvent(
      {},
      {
        eventId: "$redaction",
        kind: "redaction",
        sender: "@driver:matrix-qa.test",
        type: "m.room.redaction",
        redactsEventId: "$reaction",
      },
      {
        event_id: "$redaction",
        redacts: "$reaction",
        sender: "@driver:matrix-qa.test",
        type: "m.room.redaction",
      },
    );
  });
});
