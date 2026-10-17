import { describe, expect, it } from "vitest";
import {
  normalizeMatrixQaObservedEvent,
  type MatrixQaObservedEvent,
  type MatrixQaRoomEvent,
} from "./events.js";

const roomId = "!room:matrix-qa.test";

function expectEvent(
  event: MatrixQaRoomEvent,
  expected: Pick<MatrixQaObservedEvent, "eventId"> & Partial<MatrixQaObservedEvent>,
) {
  expect(normalizeMatrixQaObservedEvent(roomId, event)).toEqual({
    kind: "message",
    roomId,
    sender: "@sut:matrix-qa.test",
    type: "m.room.message",
    ...expected,
  });
}

describe("matrix observed event normalization", () => {
  it("normalizes message events with thread metadata", () => {
    expectEvent(
      {
        event_id: "$event",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        origin_server_ts: 1_700_000_000_000,
        content: {
          body: "hello",
          msgtype: "m.text",
          "m.mentions": {
            user_ids: ["@sut:matrix-qa.test"],
          },
          "m.relates_to": {
            rel_type: "m.thread",
            event_id: "$root",
            is_falling_back: true,
            "m.in_reply_to": {
              event_id: "$driver",
            },
          },
        },
      },
      {
        eventId: "$event",
        originServerTs: 1_700_000_000_000,
        body: "hello",
        msgtype: "m.text",
        relatesTo: {
          relType: "m.thread",
          eventId: "$root",
          inReplyToId: "$driver",
          isFallingBack: true,
        },
        mentions: {
          userIds: ["@sut:matrix-qa.test"],
        },
      },
    );
  });

  it.each([
    {
      name: "preview edit",
      content: {
        "m.relates_to": { rel_type: "m.replace", event_id: "$draft" },
        "m.new_content": { body: "preview", "org.matrix.msc4357.live": {} },
      },
      live: true,
    },
    {
      name: "final edit",
      content: {
        "org.matrix.msc4357.live": {},
        "m.relates_to": { rel_type: "m.replace", event_id: "$draft" },
        "m.new_content": { body: "final" },
      },
      live: undefined,
    },
  ])("preserves the live marker only on $name", ({ content, live }) => {
    const event = normalizeMatrixQaObservedEvent("!room:matrix-qa.test", {
      event_id: "$event",
      type: "m.room.message",
      content: { body: "preview", msgtype: "m.text", ...content },
    });
    expect(event?.live).toBe(live);
  });

  it("normalizes Matrix reaction events with target metadata", () => {
    expectEvent(
      {
        event_id: "$reaction",
        sender: "@driver:matrix-qa.test",
        type: "m.reaction",
        origin_server_ts: 1_700_000_000_000,
        content: {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: "$msg",
            key: "👍",
          },
        },
      },
      {
        kind: "reaction",
        eventId: "$reaction",
        sender: "@driver:matrix-qa.test",
        type: "m.reaction",
        originServerTs: 1_700_000_000_000,
        relatesTo: {
          eventId: "$msg",
          relType: "m.annotation",
        },
        reaction: {
          eventId: "$msg",
          key: "👍",
        },
      },
    );
  });

  it("records command presence without deriving a preview from raw approval text", () => {
    const commandText = `printf ${"A".repeat(300)}`;
    expectEvent(
      {
        event_id: "$approval",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        content: {
          body: "React here: ✅ Allow once, ❌ Deny",
          msgtype: "m.text",
          "com.openclaw.approval": {
            allowedDecisions: ["allow-once", "deny"],
            commandText,
            id: "approval-1",
            kind: "exec",
            state: "pending",
            type: "approval.request",
            version: 1,
          },
        },
      },
      {
        eventId: "$approval",
        body: "React here: ✅ Allow once, ❌ Deny",
        msgtype: "m.text",
        approval: {
          allowedDecisions: ["allow-once", "deny"],
          hasCommandText: true,
          id: "approval-1",
          kind: "exec",
          state: "pending",
          type: "approval.request",
          version: 1,
        },
      },
    );
  });

  it("summarizes Matrix plugin approval metadata fields", () => {
    expectEvent(
      {
        event_id: "$plugin-approval",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        content: {
          body: "Plugin approval required",
          msgtype: "m.text",
          "com.openclaw.approval": {
            agentId: "qa",
            allowedDecisions: ["allow-once", "deny"],
            id: "plugin:approval-1",
            kind: "plugin",
            pluginId: "qa-plugin",
            severity: "medium",
            state: "pending",
            toolName: "qa_tool",
            type: "approval.request",
            version: 1,
          },
        },
      },
      {
        eventId: "$plugin-approval",
        body: "Plugin approval required",
        msgtype: "m.text",
        approval: {
          agentId: "qa",
          allowedDecisions: ["allow-once", "deny"],
          id: "plugin:approval-1",
          kind: "plugin",
          pluginId: "qa-plugin",
          severity: "medium",
          state: "pending",
          toolName: "qa_tool",
          type: "approval.request",
          version: 1,
        },
      },
    );
  });

  it("normalizes Matrix image messages with attachment metadata", () => {
    expectEvent(
      {
        event_id: "$image",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        content: {
          body: "Protocol note: generated the QA lighthouse image successfully.",
          filename: "qa-lighthouse.png",
          msgtype: "m.image",
        },
      },
      {
        eventId: "$image",
        body: "Protocol note: generated the QA lighthouse image successfully.",
        msgtype: "m.image",
        attachment: {
          kind: "image",
          caption: "Protocol note: generated the QA lighthouse image successfully.",
          filename: "qa-lighthouse.png",
        },
      },
    );
  });

  it("treats filename-like Matrix media bodies as attachment filenames", () => {
    expectEvent(
      {
        event_id: "$image",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        content: {
          body: "qa-lighthouse.png",
          msgtype: "m.image",
        },
      },
      {
        eventId: "$image",
        body: "qa-lighthouse.png",
        msgtype: "m.image",
        attachment: {
          kind: "image",
          filename: "qa-lighthouse.png",
        },
      },
    );
  });

  it("normalizes membership events with explicit membership kind", () => {
    expectEvent(
      {
        event_id: "$membership",
        sender: "@driver:matrix-qa.test",
        state_key: "@sut:matrix-qa.test",
        type: "m.room.member",
        content: {
          membership: "leave",
        },
      },
      {
        kind: "membership",
        eventId: "$membership",
        sender: "@driver:matrix-qa.test",
        stateKey: "@sut:matrix-qa.test",
        type: "m.room.member",
        membership: "leave",
      },
    );
  });

  it("classifies Matrix redactions without needing raw event inspection", () => {
    expectEvent(
      {
        event_id: "$redaction",
        redacts: "$reaction",
        sender: "@driver:matrix-qa.test",
        type: "m.room.redaction",
        content: {},
      },
      {
        kind: "redaction",
        eventId: "$redaction",
        sender: "@driver:matrix-qa.test",
        type: "m.room.redaction",
        redactsEventId: "$reaction",
      },
    );
  });
});
