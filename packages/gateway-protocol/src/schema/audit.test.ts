import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { validateAuditListParams } from "../index.js";
import { AuditEventSchema } from "./audit.js";

describe("audit protocol schemas", () => {
  it("accepts bounded query filters and rejects oversized pages", () => {
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
    expect(validateAuditListParams({ limit: 501 })).toBe(false);
  });

  it("rejects content fields from metadata-only records", () => {
    const validate = Compile(AuditEventSchema);
    const event = {
      eventId: "event-1",
      sequence: 1,
      sourceSequence: 1,
      occurredAt: 1,
      kind: "tool_action",
      action: "tool.action.finished",
      status: "unknown",
      errorCode: "tool_outcome_unknown",
      actor: { type: "agent", id: "main" },
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "exec",
      redaction: "metadata_only",
    };
    expect(validate.Check(event)).toBe(true);
    expect(validate.Check({ ...event, result: "secret" })).toBe(false);
  });
});
