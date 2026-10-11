import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { validateAuditActivityListParams, validateAuditListParams } from "../index.js";
import {
  AuditActivityEventV1Schema,
  AuditActivityInboundMessageV1Schema,
} from "./audit-activity.js";
import { AuditEventSchema } from "./audit.js";

const accountRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;

describe("legacy audit protocol schemas", () => {
  it("accepts only the shipped audit.list filters", () => {
    expect(
      validateAuditListParams({
        agentId: "main",
        kind: "tool_action",
        status: "failed",
        limit: 500,
        cursor: "42",
      }),
    ).toBe(true);
    expect(validateAuditListParams({ status: "unknown" })).toBe(true);
    expect(validateAuditListParams({ kind: "message" })).toBe(false);
    expect(validateAuditListParams({ direction: "outbound" })).toBe(false);
    expect(validateAuditListParams({ includeMessages: true })).toBe(false);
    expect(validateAuditListParams({ limit: 501 })).toBe(false);
  });

  it("preserves the shipped run/tool event shape", () => {
    const validate = Compile(AuditEventSchema);
    const event = {
      eventId: "event-1",
      sequence: 1,
      sourceSequence: 2,
      occurredAt: 3,
      kind: "tool_action",
      action: "tool.action.finished",
      status: "failed",
      errorCode: "tool_failed",
      actor: { type: "agent", id: "main" },
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "run-1",
      toolCallId: "call-fingerprint",
      toolName: "exec",
      redaction: "metadata_only",
    };

    expect(validate.Check(event)).toBe(true);
    expect(validate.Check({ ...event, schemaVersion: 1 })).toBe(false);
    expect(validate.Check({ ...event, result: "secret" })).toBe(false);
  });
});

describe("audit activity protocol schemas", () => {
  it("accepts bounded message filters", () => {
    expect(
      validateAuditActivityListParams({
        kind: "message",
        direction: "outbound",
        channel: "telegram",
        limit: 500,
      }),
    ).toBe(true);
    expect(validateAuditActivityListParams({ direction: "inbound" })).toBe(true);
    expect(validateAuditActivityListParams({ direction: "sideways" })).toBe(false);
    expect(validateAuditActivityListParams({ limit: 501 })).toBe(false);
  });

  it("uses an integer V1 schema version and exact HMAC references", () => {
    const validate = Compile(AuditActivityInboundMessageV1Schema);
    const event = {
      eventType: "inbound_message",
      schemaVersion: 1,
      eventId: "event-message-1",
      sequence: 2,
      sourceSequence: 3,
      occurredAt: 4,
      kind: "message",
      action: "message.inbound.processed",
      status: "succeeded",
      actor: { type: "channel_sender", id: accountRef },
      direction: "inbound",
      channel: "telegram",
      conversationKind: "direct",
      outcome: "completed",
      accountRef,
      redaction: "metadata_only",
    };

    expect(validate.Check(event)).toBe(true);
    expect(validate.Check({ ...event, schemaVersion: 1.5 })).toBe(false);
    expect(validate.Check({ ...event, schemaVersion: 2 })).toBe(false);
    expect(validate.Check({ ...event, accountRef: "hmac256:account" })).toBe(false);
    expect(validate.Check({ ...event, actor: { type: "channel_sender", id: "raw-user" } })).toBe(
      false,
    );
    expect(validate.Check({ ...event, text: "secret message" })).toBe(false);
  });

  it("rejects contradictory inbound message terminals", () => {
    const validate = Compile(AuditActivityEventV1Schema);
    const inbound = {
      eventType: "inbound_message",
      schemaVersion: 1,
      eventId: "event-inbound-1",
      sequence: 1,
      sourceSequence: 1,
      occurredAt: 1,
      kind: "message",
      action: "message.inbound.processed",
      direction: "inbound",
      channel: "telegram",
      conversationKind: "direct",
      actor: { type: "channel_sender", id: accountRef },
      status: "succeeded",
      outcome: "completed",
      redaction: "metadata_only",
    };

    expect(validate.Check(inbound)).toBe(true);
    expect(
      validate.Check({
        ...inbound,
        outcome: "failed",
        errorCode: "message_processing_failed",
      }),
    ).toBe(false);
    expect(validate.Check({ ...inbound, reasonCode: "duplicate" })).toBe(false);
    expect(validate.Check({ ...inbound, status: "unknown", outcome: "unknown" })).toBe(false);
  });
});
