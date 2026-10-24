import { describe, expect, it } from "vitest";
import {
  normalizeMatrixQaObservedEvent,
  type MatrixQaObservedEvent,
  type MatrixQaRoomEvent,
} from "./events.js";

const roomId = "!room:matrix-qa.test";
const sender = "@sut:matrix-qa.test";
const driver = "@driver:matrix-qa.test";
const timestamp = 1_700_000_000_000;
const approval = {
  allowedDecisions: ["allow-once", "deny"],
  state: "pending",
  type: "approval.request",
  version: 1,
};
const plugin = {
  id: "plugin:approval-1",
  kind: "plugin",
  agentId: "qa",
  pluginId: "qa-plugin",
  severity: "medium",
  toolName: "qa_tool",
};
type Case = [
  string,
  Record<string, unknown>,
  Partial<MatrixQaObservedEvent>,
  Partial<MatrixQaRoomEvent>?,
];

describe("matrix observed event normalization", () => {
  it.each<Case>([
    [
      "threaded message",
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
        originServerTs: timestamp,
        body: "hello",
        msgtype: "m.text",
        mentions: { userIds: [sender] },
        relatesTo: {
          relType: "m.thread",
          eventId: "$root",
          inReplyToId: "$driver",
          isFallingBack: true,
        },
      },
      { origin_server_ts: timestamp },
    ],
    [
      "reaction",
      {
        "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key: "👍" },
      },
      {
        kind: "reaction",
        originServerTs: timestamp,
        relatesTo: { eventId: "$msg", relType: "m.annotation" },
        reaction: { eventId: "$msg", key: "👍" },
      },
      { type: "m.reaction", event_id: "$reaction", sender: driver, origin_server_ts: timestamp },
    ],
    [
      "membership",
      { membership: "leave" },
      {
        kind: "membership",
        stateKey: sender,
        membership: "leave",
      },
      { type: "m.room.member", event_id: "$membership", sender: driver, state_key: sender },
    ],
    [
      "redaction",
      {},
      { kind: "redaction", redactsEventId: "$reaction" },
      { type: "m.room.redaction", event_id: "$redaction", sender: driver, redacts: "$reaction" },
    ],
    [
      "image with caption",
      { body: "Image caption", filename: "qa-lighthouse.png", msgtype: "m.image" },
      {
        body: "Image caption",
        msgtype: "m.image",
        attachment: { kind: "image", caption: "Image caption", filename: "qa-lighthouse.png" },
      },
      { event_id: "$image" },
    ],
    [
      "image with filename-like body",
      { body: "qa-lighthouse.png", msgtype: "m.image" },
      {
        body: "qa-lighthouse.png",
        msgtype: "m.image",
        attachment: { kind: "image", filename: "qa-lighthouse.png" },
      },
      { event_id: "$image" },
    ],
    [
      "approval without raw command text",
      {
        body: "React here: ✅ Allow once, ❌ Deny",
        msgtype: "m.text",
        "com.openclaw.approval": {
          ...approval,
          id: "approval-1",
          kind: "exec",
          commandText: "printf " + "A".repeat(300),
        },
      },
      {
        body: "React here: ✅ Allow once, ❌ Deny",
        msgtype: "m.text",
        approval: { ...approval, id: "approval-1", kind: "exec", hasCommandText: true },
      },
      { event_id: "$approval" },
    ],
    [
      "plugin approval metadata",
      {
        body: "Plugin approval required",
        msgtype: "m.text",
        "com.openclaw.approval": { ...approval, ...plugin },
      },
      {
        body: "Plugin approval required",
        msgtype: "m.text",
        approval: { ...approval, ...plugin, kind: "plugin" },
      },
      { event_id: "$plugin-approval" },
    ],
  ] satisfies Case[])("normalizes %s", (_name, content, expected, envelope = {}) => {
    const event = { event_id: "$event", sender, type: "m.room.message", ...envelope, content };
    expect(normalizeMatrixQaObservedEvent(roomId, event)).toEqual({
      eventId: event.event_id,
      kind: "message",
      roomId,
      sender: event.sender,
      type: event.type,
      ...expected,
    });
  });

  it.each([
    ["preview edit", { body: "preview", "org.matrix.msc4357.live": {} }, {}, true],
    ["final edit", { body: "final" }, { "org.matrix.msc4357.live": {} }, undefined],
  ] as const)("preserves the live marker only on %s", (_name, newContent, outerContent, live) => {
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
});
