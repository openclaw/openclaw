import { Compile } from "typebox/compile";
import { describe, it } from "vitest";
import { validateAuditActivityListParams, validateAuditListParams } from "../index.js";
import {
  AuditActivityEventV1Schema,
  AuditActivityInboundMessageV1Schema,
} from "./audit-activity.js";
import { AuditEventSchema } from "./audit.js";
import { validation, withOverrides } from "./protocol-validation.test-support.js";

const legacy = validation(validateAuditListParams);
const activity = validation(validateAuditActivityListParams);
const accountRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
const metadata = {
  eventId: "event-1",
  sequence: 1,
  sourceSequence: 2,
  occurredAt: 3,
  redaction: "metadata_only",
};
const inbound = {
  ...metadata,
  eventType: "inbound_message",
  schemaVersion: 1,
  kind: "message",
  action: "message.inbound.processed",
  status: "succeeded",
  actor: { type: "channel_sender", id: accountRef },
  direction: "inbound",
  channel: "telegram",
  conversationKind: "direct",
  outcome: "completed",
};

describe("audit protocol schemas", () => {
  it("accepts only shipped legacy audit filters", () => {
    legacy.accepts(
      { agentId: "main", kind: "tool_action", status: "failed", limit: 500, cursor: "42" },
      { status: "unknown" },
    );
    legacy.rejects(
      { kind: "message" },
      { direction: "outbound" },
      { includeMessages: true },
      { limit: 501 },
    );
  });
  it("preserves the shipped run/tool event shape", () => {
    const event = {
      ...metadata,
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
    };
    const validate = Compile(AuditEventSchema);
    const proof = validation((value) => validate.Check(value));
    proof.accepts(event);
    proof.rejects({ ...event, schemaVersion: 1 }, { ...event, result: "secret" });
  });
  it("accepts bounded activity message filters", () => {
    activity.accepts(
      { kind: "message", direction: "outbound", channel: "telegram", limit: 500 },
      { direction: "inbound" },
    );
    activity.rejects({ direction: "sideways" }, { limit: 501 });
  });
  it.each([
    ["inbound", AuditActivityInboundMessageV1Schema],
    ["activity union", AuditActivityEventV1Schema],
  ] as const)("enforces V1 privacy and terminal consistency via %s", (_name, schema) => {
    const validate = Compile(schema);
    const proof = validation((value) => validate.Check(value));
    const event = { ...inbound, accountRef };
    proof.accepts(inbound, event);
    proof.rejects(
      ...[
        { schemaVersion: 1.5 },
        { schemaVersion: 2 },
        { accountRef: "hmac256:account" },
        { actor: { type: "channel_sender", id: "raw-user" } },
        { text: "secret message" },
        { outcome: "failed", errorCode: "message_processing_failed" },
        { reasonCode: "duplicate" },
        { status: "unknown", outcome: "unknown" },
      ].map(withOverrides(event)),
    );
  });
});
