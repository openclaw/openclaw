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
import { check, schemaValidation, validation } from "./schema/protocol-validation.test-support.js";

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

const presentation = validation(validatePresentation);
const result = validation((approval) => validateResult({ approval }));
const resolve = validation(validateResolve);
const historyParams = validation(validateApprovalHistoryParams);
const historyResult = validation(validateApprovalHistoryResult);
const resolveResult = validation(validateApprovalResolveResult);

describe("unified approval protocol validators", () => {
  it("accepts only reviewer-safe approval presentations", () => {
    const external = (overrides: Record<string, unknown>) => ({
      ...pluginPresentation,
      externalResolution: { label: "Verify", decisions: ["allow-once"], ...overrides },
    });
    presentation.accepts(execPresentation, pluginPresentation, systemAgentPresentation);
    presentation.accepts({
      ...external({ label: "Verify with World", decisions: ["allow-once", "allow-always"] }),
      allowedDecisions: ["deny"],
    });
    presentation.accepts({ ...pluginPresentation, detail: "full tool input" });
    presentation.rejects(
      { ...pluginPresentation, detail: "" },
      { ...pluginPresentation, detail: "x".repeat(16_385) },
    );
    presentation.rejects(external({ label: "" }));
    const astralLabel = String.fromCodePoint(0x1f680).repeat(80);
    presentation.accepts(external({ label: astralLabel }));
    presentation.rejects(external({ label: `${astralLabel}${String.fromCodePoint(0x1f680)}` }));
    presentation.rejects(external({ decisions: ["deny"] }), external({ proof: "private" }));

    for (const forbiddenField of ["cwd", "env", "systemRunBinding", "systemRunPlan"] as const) {
      presentation.rejects({
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
      presentation.accepts({ ...execPresentation, scope });
      presentation.accepts({ ...pluginPresentation, scope });
      presentation.rejects({ ...pluginPresentation, scope: { ...scope, extra: true } });
    }

    presentation.rejects({ ...systemAgentPresentation, scope: scopes[0] });
    presentation.rejects({
      ...pluginPresentation,
      scope: { ...scopes[0], recipients: Array(6).fill("person@example.com") },
    });
  });

  it("keeps deny available on every presentation and resolve request", () => {
    presentation.rejects({ ...execPresentation, allowedDecisions: ["allow-once"] });
    presentation.rejects({ ...pluginPresentation, allowedDecisions: ["allow-always"] });
    resolve.accepts({ id: execRecord.id, kind: "exec", decision: "deny" });
    resolve.rejects({ id: execRecord.id, decision: "deny" });
    resolve.rejects({ id: execRecord.id, kind: "exec", decision: "accept" });
  });

  it("accepts only complete channel reviewer facts on every resolve surface", () => {
    const reviewer = { channel: "telegram", accountId: "ops", senderId: "owner" };
    resolve.accepts({ id: execRecord.id, kind: "exec", decision: "deny", reviewer });
    check(validateExecResolve, [{ id: execRecord.id, decision: "deny", reviewer }]);
    check(validatePluginResolve, [{ id: pluginRecord.id, decision: "deny", reviewer }]);
    resolve.rejects({
      id: execRecord.id,
      kind: "exec",
      decision: "deny",
      reviewer: { channel: "telegram", accountId: "ops" },
    });
  });

  it("validates pending and every fail-closed terminal state", () => {
    const pending = { ...execRecord, status: "pending" };
    const allowed = { ...terminal, status: "allowed", decision: "allow-once" };
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

    result.accepts(pending, allowed, denied, expired, cancelled);
    result.rejects(
      { ...allowed, decision: "deny" },
      { ...allowed, resolvedBy: "device:phone" },
      { ...denied, reason: "" },
      { ...expired, decision: "deny" },
      {
        ...execRecord,
        presentation: { ...execPresentation, kind: "plugin" },
        status: "pending",
      },
    );
  });

  it("uses one full-id field and rejects internal routing state", () => {
    check(validateGet, [{ id: pluginRecord.id }]);
    check(validateGet, [], [{ id: "" }, { id: pluginRecord.id, kind: "plugin" }]);
    resolve.rejects({ id: "plugin", kind: "plugin", decision: "deny", prefix: true });
    resolve.rejects({ id: "plugin", kind: "plugin", decision: "deny", resolvedBy: "public-actor" });
    for (const id of ["\ud800", "\udc00", ".", ".."]) {
      check(validateGet, [], [{ id }]);
      resolve.rejects({ id, kind: "exec", decision: "deny" });
    }
    check(validateGet, [{ id: "approval:🦞/percent%" }]);

    result.accepts({
      ...execRecord,
      status: "pending",
      sourceSessionKey: "agent:worker:subagent:123",
    });
    result.rejects({
      ...execRecord,
      status: "pending",
      audienceSessionKeys: ["agent:worker:subagent:123", "agent:main"],
    });
  });

  it("validates terminal history pages and optional attribution", () => {
    const terminal = settled(pluginRecord, {
      status: "denied",
      decision: "deny",
      reason: "user",
      source: { agentId: "release", sessionKey: "agent:release:main" },
      resolver: { kind: "device", id: "reviewer-device" },
    });
    historyParams.accepts({}, { cursor: "cursor", limit: 50, kind: "plugin" });
    historyParams.rejects({ limit: 0 }, { limit: 101 }, { kind: "tool" });
    historyResult.accepts({ items: [terminal], nextCursor: "next" });
    historyResult.rejects(
      { items: [{ ...execRecord, status: "pending" }] },
      { items: [terminal], extra: true },
    );
  });

  it("returns the canonical recorded snapshot to losing resolvers", () => {
    const recorded = { ...terminal, status: "allowed", decision: "allow-always" };
    resolveResult.accepts(
      { applied: true, approval: recorded },
      { applied: false, approval: recorded },
    );
    resolveResult.rejects(
      { applied: false, approval: { ...execRecord, status: "pending" } },
      { applied: false },
    );
  });
});

const pending = {
  ...execRecord,
  status: "pending",
  sourceSessionKey: "agent:worker:subagent:child",
} as const;
const terminal = settled(execRecord, { status: "denied", decision: "deny", reason: "user" });
const event = (phase: string, snapshot: unknown) => ({
  sessionKey: "agent:main:main",
  sourceSessionKey: "agent:worker:subagent:child",
  updatedAtMs: terminal.resolvedAtMs,
  phase,
  approval: snapshot,
});
const events = schemaValidation(SessionApprovalEventSchema);
const replays = schemaValidation(SessionApprovalReplaySchema);

describe("session approval protocol validators", () => {
  it("keeps approval subscription opt-in additive and literal", () => {
    check(validateSessionsMessagesSubscribeParams, [{ key: "agent:main:main" }]);
    const subscribe = (includeApprovals: boolean) =>
      validateSessionsMessagesSubscribeParams({ key: "agent:main:main", includeApprovals });
    expect(subscribe(true)).toBe(true);
    expect(subscribe(false)).toBe(false);
  });

  it("requires event phase to match the approval snapshot state", () => {
    events.accepts(event("pending", pending), event("terminal", terminal));
    events.rejects(event("pending", terminal), event("terminal", pending));
  });

  it("rejects terminal reasons that contradict the terminal status", () => {
    const terminalCommon = { ...execRecord, resolvedAtMs: terminal.resolvedAtMs } as const;

    for (const snapshot of [
      { ...terminal, reason: "timeout" },
      { ...terminalCommon, status: "allowed", decision: "allow-once", reason: "timeout" },
      { ...terminalCommon, status: "expired", reason: "user" },
      { ...terminalCommon, status: "cancelled", reason: "timeout" },
    ]) {
      events.rejects(event("terminal", snapshot));
    }
  });

  it("keeps pending replay authoritative", () => {
    const replay = {
      sessionKey: "agent:main:main",
      updatedAtMs: execRecord.createdAtMs,
      approvals: [pending],
      truncated: false,
    } as const;

    replays.accepts(replay);
    replays.rejects({ ...replay, approvals: [terminal] });
  });
});
