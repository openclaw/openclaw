import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { validateAuditActivityListParams, validateAuditListParams } from "../index.js";
import {
  AuditActivityEventV1Schema,
  AuditActivityInboundMessageV1Schema,
} from "./audit-activity.js";
import { AuditEventSchema } from "./audit.js";

const accountRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
const inbound = {
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
  redaction: "metadata_only",
};

describe("legacy audit protocol schemas", () => {
  it("accepts only the shipped audit.list filters", () => {
    const filters = {
      agentId: "main",
      kind: "tool_action",
      status: "failed",
      limit: 500,
      cursor: "42",
    };
    expect(validateAuditListParams(filters)).toBe(true);
    expect(validateAuditListParams({ status: "unknown" })).toBe(true);
    for (const invalid of [
      { kind: "message" },
      { direction: "outbound" },
      { includeMessages: true },
      { limit: 501 },
    ]) {
      expect(validateAuditListParams(invalid)).toBe(false);
    }
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
    const filters = { kind: "message", direction: "outbound", channel: "telegram", limit: 500 };
    expect(validateAuditActivityListParams(filters)).toBe(true);
    expect(validateAuditActivityListParams({ direction: "inbound" })).toBe(true);
    expect(validateAuditActivityListParams({ direction: "sideways" })).toBe(false);
    expect(validateAuditActivityListParams({ limit: 501 })).toBe(false);
  });

  it("uses an integer V1 schema version and exact HMAC references", () => {
    const validate = Compile(AuditActivityInboundMessageV1Schema);
    const event = { ...inbound, accountRef };
    expect(validate.Check(event)).toBe(true);
    for (const invalid of [
      { schemaVersion: 1.5 },
      { schemaVersion: 2 },
      { accountRef: "hmac256:account" },
      { actor: { type: "channel_sender", id: "raw-user" } },
      { text: "secret message" },
    ]) {
      expect(validate.Check({ ...event, ...invalid })).toBe(false);
    }
  });

  it("rejects contradictory inbound message terminals", () => {
    const validate = Compile(AuditActivityEventV1Schema);
    expect(validate.Check(inbound)).toBe(true);
    for (const invalid of [
      { outcome: "failed", errorCode: "message_processing_failed" },
      { reasonCode: "duplicate" },
      { status: "unknown", outcome: "unknown" },
    ]) {
      expect(validate.Check({ ...inbound, ...invalid })).toBe(false);
    }
  });
});
