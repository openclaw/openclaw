import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionApprovalEventSchema,
  SessionApprovalReplaySchema,
  validateSessionsMessagesSubscribeParams,
} from "./index.js";

const approval = {
  id: "approval:01JZ4K6M2X8YQW9N7R3T5V1C0B",
  urlPath: "/approve/approval%3A01JZ4K6M2X8YQW9N7R3T5V1C0B",
  presentation: {
    kind: "exec",
    commandText: "git status --short",
    commandPreview: "git status",
    warningText: null,
    host: "gateway",
    nodeId: null,
    agentId: "main",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  },
  createdAtMs: 1_780_000_000_000,
  expiresAtMs: 1_780_001_800_000,
} as const;

const pending = {
  ...approval,
  status: "pending",
  sourceSessionKey: "agent:worker:subagent:child",
} as const;
const terminal = {
  ...approval,
  status: "denied",
  decision: "deny",
  resolvedAtMs: approval.createdAtMs + 1_000,
  reason: "user",
} as const;
const event = (phase: string, snapshot: unknown) =>
  Value.Check(SessionApprovalEventSchema, {
    sessionKey: "agent:main:main",
    sourceSessionKey: "agent:worker:subagent:child",
    updatedAtMs: terminal.resolvedAtMs,
    phase,
    approval: snapshot,
  });

describe("session approval protocol validators", () => {
  it("keeps approval subscription opt-in additive and literal", () => {
    expect(validateSessionsMessagesSubscribeParams({ key: "agent:main:main" })).toBe(true);
    const subscribe = (includeApprovals: boolean) =>
      validateSessionsMessagesSubscribeParams({ key: "agent:main:main", includeApprovals });
    expect(subscribe(true)).toBe(true);
    expect(subscribe(false)).toBe(false);
  });

  it("requires event phase to match the approval snapshot state", () => {
    expect(event("pending", pending)).toBe(true);
    expect(event("terminal", terminal)).toBe(true);
    expect(event("pending", terminal)).toBe(false);
    expect(event("terminal", pending)).toBe(false);
  });

  it("rejects terminal reasons that contradict the terminal status", () => {
    const terminalCommon = {
      ...approval,
      resolvedAtMs: terminal.resolvedAtMs,
    } as const;

    for (const snapshot of [
      { ...terminal, reason: "timeout" },
      { ...terminalCommon, status: "allowed", decision: "allow-once", reason: "timeout" },
      { ...terminalCommon, status: "expired", reason: "user" },
      { ...terminalCommon, status: "cancelled", reason: "timeout" },
    ]) {
      expect(event("terminal", snapshot)).toBe(false);
    }
  });

  it("keeps pending replay authoritative", () => {
    const replay = {
      sessionKey: "agent:main:main",
      updatedAtMs: approval.createdAtMs,
      approvals: [pending],
      truncated: false,
    } as const;

    expect(Value.Check(SessionApprovalReplaySchema, replay)).toBe(true);
    expect(Value.Check(SessionApprovalReplaySchema, { ...replay, approvals: [terminal] })).toBe(
      false,
    );
  });
});
