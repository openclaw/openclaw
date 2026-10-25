import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  validateApprovalHistoryParams,
  validateApprovalHistoryResult,
  validateApprovalResolveResult,
  SessionApprovalEventSchema,
  SessionApprovalReplaySchema,
  validateSessionsMessagesSubscribeParams,
  validateApprovalGetParams as validateGet,
  validateApprovalGetResult as validateResult,
  validateApprovalPresentation as validatePresentation,
  validateApprovalResolveParams as validateResolve,
  validateExecApprovalResolveParams as validateExecResolve,
  validatePluginApprovalResolveParams as validatePluginResolve,
} from "./index.js";
import { check } from "./schema/protocol-validation.test-support.js";

const execPresentation = {
  kind: "exec",
  commandText: "git status --short",
  commandPreview: "git status",
  warningText: null,
  host: "gateway",
  nodeId: null,
  agentId: "main",
  allowedDecisions: ["allow-once", "allow-always", "deny"],
} as const;
const execRecord = {
  id: "approval:01JZ4K6M2X8YQW9N7R3T5V1C0B",
  urlPath: "/approve/approval%3A01JZ4K6M2X8YQW9N7R3T5V1C0B",
  presentation: execPresentation,
  createdAtMs: 1_780_000_000_000,
  expiresAtMs: 1_780_001_800_000,
} as const;

const pluginPresentation = {
  kind: "plugin",
  title: "Publish release",
  description: "Publish version 1.2.3 to the package registry.",
  severity: "critical",
  pluginId: "publisher",
  toolName: "publish",
  agentId: "release",
  allowedDecisions: ["allow-once", "deny"],
} as const;

const systemAgentPresentation = {
  kind: "system-agent",
  title: "OpenClaw change",
  description: "Set gateway.port to 19001",
  proposalHash: "a".repeat(64),
  agentId: "main",
  allowedDecisions: ["allow-once", "deny"],
} as const;

const pluginRecord = {
  ...execRecord,
  id: "plugin:01JZ4K6M2X8YQW9N7R3T5V1C0B",
  urlPath: "/approve/plugin%3A01JZ4K6M2X8YQW9N7R3T5V1C0B",
  presentation: pluginPresentation,
  expiresAtMs: 1_780_000_120_000,
} as const;

const settled = (record: typeof execRecord | typeof pluginRecord, fields: object) => ({
  ...record,
  resolvedAtMs: record.createdAtMs + 1_000,
  ...fields,
});

const presentation = (value: unknown) => check(validatePresentation, [value]);
const rejectPresentation = (value: unknown) => check(validatePresentation, [], [value]);
const result = (approval: unknown) => check(validateResult, [{ approval }]);
const rejectResult = (approval: unknown) => check(validateResult, [], [{ approval }]);
const resolve = (value: unknown) => check(validateResolve, [value]);
const rejectResolve = (value: unknown) => check(validateResolve, [], [value]);

describe("unified approval protocol validators", () => {
  it("accepts only reviewer-safe approval presentations", () => {
    const external = (overrides: Record<string, unknown>) => ({
      ...pluginPresentation,
      externalResolution: { label: "Verify", decisions: ["allow-once"], ...overrides },
    });
    presentation(execPresentation);
    presentation(pluginPresentation);
    presentation(systemAgentPresentation);
    presentation({
      ...external({ label: "Verify with World", decisions: ["allow-once", "allow-always"] }),
      allowedDecisions: ["deny"],
    });
    presentation({ ...pluginPresentation, detail: "full tool input" });
    rejectPresentation({ ...pluginPresentation, detail: "" });
    rejectPresentation({ ...pluginPresentation, detail: "x".repeat(16_385) });
    rejectPresentation(external({ label: "" }));
    const astralLabel = String.fromCodePoint(0x1f680).repeat(80);
    presentation(external({ label: astralLabel }));
    rejectPresentation(external({ label: `${astralLabel}${String.fromCodePoint(0x1f680)}` }));
    rejectPresentation(external({ decisions: ["deny"] }));
    rejectPresentation(external({ proof: "private" }));

    for (const forbiddenField of ["cwd", "env", "systemRunBinding", "systemRunPlan"] as const) {
      rejectPresentation({
        ...execPresentation,
        [forbiddenField]: forbiddenField === "env" ? { TOKEN: "secret" } : "private",
      });
    }
  });

  it("accepts bounded owner-declared approval scopes and rejects unknown scope fields", () => {
    const scopes = [
      {
        kind: "message-send",
        target: "email",
        recipientCount: 3,
        recipients: ["alice@example.com", "bob@example.com"],
        audience: "external",
      },
      { kind: "payment", amount: "49.99", currency: "EUR", target: "Stripe" },
      { kind: "external-post", target: "github", visibility: "public" },
    ] as const;

    for (const scope of scopes) {
      presentation({ ...execPresentation, scope });
      presentation({ ...pluginPresentation, scope });
      rejectPresentation({ ...pluginPresentation, scope: { ...scope, extra: true } });
    }

    rejectPresentation({ ...systemAgentPresentation, scope: scopes[0] });
    rejectPresentation({
      ...pluginPresentation,
      scope: { ...scopes[0], recipients: Array(6).fill("person@example.com") },
    });
  });

  it("keeps deny available on every presentation and resolve request", () => {
    rejectPresentation({ ...execPresentation, allowedDecisions: ["allow-once"] });
    rejectPresentation({ ...pluginPresentation, allowedDecisions: ["allow-always"] });
    resolve({ id: execRecord.id, kind: "exec", decision: "deny" });
    rejectResolve({ id: execRecord.id, decision: "deny" });
    rejectResolve({ id: execRecord.id, kind: "exec", decision: "accept" });
  });

  it("accepts only complete channel reviewer facts on every resolve surface", () => {
    const reviewer = { channel: "telegram", accountId: "ops", senderId: "owner" };
    resolve({ id: execRecord.id, kind: "exec", decision: "deny", reviewer });
    check(validateExecResolve, [{ id: execRecord.id, decision: "deny", reviewer }]);
    check(validatePluginResolve, [{ id: pluginRecord.id, decision: "deny", reviewer }]);
    rejectResolve({
      id: execRecord.id,
      kind: "exec",
      decision: "deny",
      reviewer: { channel: "telegram", accountId: "ops" },
    });
  });

  it("validates pending and every fail-closed terminal state", () => {
    const pending = { ...execRecord, status: "pending" } as const;
    const allowed = settled(execRecord, {
      status: "allowed",
      decision: "allow-once",
      reason: "user",
    });
    const denied = settled(pluginRecord, { status: "denied", decision: "deny", reason: "user" });
    const expired = settled(execRecord, {
      status: "expired",
      resolvedAtMs: execRecord.expiresAtMs,
      reason: "timeout",
    });
    const cancelled = settled(pluginRecord, {
      status: "cancelled",
      resolvedAtMs: pluginRecord.createdAtMs + 500,
      reason: "run-aborted",
    });

    for (const snapshot of [pending, allowed, denied, expired, cancelled]) {
      result(snapshot);
    }

    rejectResult({ ...allowed, decision: "deny" });
    rejectResult({ ...allowed, resolvedBy: "device:phone" });
    rejectResult({ ...denied, reason: "" });
    rejectResult({ ...expired, decision: "deny" });
    rejectResult({
      ...execRecord,
      presentation: { ...execPresentation, kind: "plugin" },
      status: "pending",
    });
  });

  it("uses one full-id field and rejects internal routing state", () => {
    check(validateGet, [{ id: pluginRecord.id }]);
    check(validateGet, [], [{ id: "" }, { id: pluginRecord.id, kind: "plugin" }]);
    rejectResolve({ id: "plugin", kind: "plugin", decision: "deny", prefix: true });
    rejectResolve({ id: "plugin", kind: "plugin", decision: "deny", resolvedBy: "public-actor" });
    for (const id of ["\ud800", "\udc00", ".", ".."]) {
      check(validateGet, [], [{ id }]);
      rejectResolve({ id, kind: "exec", decision: "deny" });
    }
    check(validateGet, [{ id: "approval:🦞/percent%" }]);

    result({
      ...execRecord,
      status: "pending",
      sourceSessionKey: "agent:worker:subagent:123",
    });
    rejectResult({
      ...execRecord,
      status: "pending",
      audienceSessionKeys: ["agent:worker:subagent:123", "agent:main"],
    });
  });

  it("validates terminal history pages and optional attribution", () => {
    const terminal = {
      ...pluginRecord,
      status: "denied",
      decision: "deny",
      resolvedAtMs: pluginRecord.createdAtMs + 1_000,
      reason: "user",
      source: { agentId: "release", sessionKey: "agent:release:main" },
      resolver: { kind: "device", id: "reviewer-device" },
    } as const;

    expect(validateApprovalHistoryParams({})).toBe(true);
    expect(validateApprovalHistoryParams({ cursor: "cursor", limit: 50, kind: "plugin" })).toBe(
      true,
    );
    expect(validateApprovalHistoryParams({ limit: 0 })).toBe(false);
    expect(validateApprovalHistoryParams({ limit: 101 })).toBe(false);
    expect(validateApprovalHistoryParams({ kind: "tool" })).toBe(false);

    expect(validateApprovalHistoryResult({ items: [terminal], nextCursor: "next" })).toBe(true);
    expect(validateApprovalHistoryResult({ items: [{ ...execRecord, status: "pending" }] })).toBe(
      false,
    );
    expect(validateApprovalHistoryResult({ items: [terminal], extra: true })).toBe(false);
  });

  it("returns the canonical recorded snapshot to losing resolvers", () => {
    const recorded = {
      ...execRecord,
      status: "allowed",
      decision: "allow-always",
      resolvedAtMs: execRecord.createdAtMs + 1_000,
      reason: "user",
    } as const;

    expect(validateApprovalResolveResult({ applied: true, approval: recorded })).toBe(true);
    expect(validateApprovalResolveResult({ applied: false, approval: recorded })).toBe(true);
    expect(
      validateApprovalResolveResult({
        applied: false,
        approval: { ...execRecord, status: "pending" },
      }),
    ).toBe(false);
    expect(validateApprovalResolveResult({ applied: false })).toBe(false);
  });
});

const pending = {
  ...execRecord,
  status: "pending",
  sourceSessionKey: "agent:worker:subagent:child",
} as const;
const terminal = settled(execRecord, { status: "denied", decision: "deny", reason: "user" });
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
    check(validateSessionsMessagesSubscribeParams, [{ key: "agent:main:main" }]);
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
      ...execRecord,
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
      updatedAtMs: execRecord.createdAtMs,
      approvals: [pending],
      truncated: false,
    } as const;

    expect(Value.Check(SessionApprovalReplaySchema, replay)).toBe(true);
    expect(Value.Check(SessionApprovalReplaySchema, { ...replay, approvals: [terminal] })).toBe(
      false,
    );
  });
});
