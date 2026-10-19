import { describe, expect, it } from "vitest";
import {
  validateApprovalGetParams,
  validateApprovalGetResult,
  validateApprovalHistoryParams,
  validateApprovalHistoryResult,
  validateApprovalPresentation,
  validateApprovalResolveParams,
  validateExecApprovalResolveParams,
  validatePluginApprovalResolveParams,
  validateApprovalResolveResult,
} from "./index.js";

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

const execRecord = {
  id: "approval:01JZ4K6M2X8YQW9N7R3T5V1C0B",
  urlPath: "/approve/approval%3A01JZ4K6M2X8YQW9N7R3T5V1C0B",
  presentation: execPresentation,
  createdAtMs: 1_780_000_000_000,
  expiresAtMs: 1_780_001_800_000,
} as const;

const pluginRecord = {
  ...execRecord,
  id: "plugin:01JZ4K6M2X8YQW9N7R3T5V1C0B",
  urlPath: "/approve/plugin%3A01JZ4K6M2X8YQW9N7R3T5V1C0B",
  presentation: pluginPresentation,
  expiresAtMs: 1_780_000_120_000,
} as const;

const presentation = (value: unknown) => expect(validateApprovalPresentation(value)).toBe(true);
const rejectPresentation = (value: unknown) =>
  expect(validateApprovalPresentation(value)).toBe(false);
const result = (approval: unknown) => expect(validateApprovalGetResult({ approval })).toBe(true);
const rejectResult = (approval: unknown) =>
  expect(validateApprovalGetResult({ approval })).toBe(false);
const resolve = (value: unknown) => expect(validateApprovalResolveParams(value)).toBe(true);
const rejectResolve = (value: unknown) => expect(validateApprovalResolveParams(value)).toBe(false);

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
    expect(
      validateExecApprovalResolveParams({ id: execRecord.id, decision: "deny", reviewer }),
    ).toBe(true);
    expect(
      validatePluginApprovalResolveParams({ id: pluginRecord.id, decision: "deny", reviewer }),
    ).toBe(true);
    rejectResolve({
      id: execRecord.id,
      kind: "exec",
      decision: "deny",
      reviewer: { channel: "telegram", accountId: "ops" },
    });
  });

  it("validates pending and every fail-closed terminal state", () => {
    const pending = { ...execRecord, status: "pending" } as const;
    const allowed = {
      ...execRecord,
      status: "allowed",
      decision: "allow-once",
      resolvedAtMs: execRecord.createdAtMs + 1_000,
      reason: "user",
    } as const;
    const denied = {
      ...pluginRecord,
      status: "denied",
      decision: "deny",
      resolvedAtMs: pluginRecord.createdAtMs + 1_000,
      reason: "user",
    } as const;
    const expired = {
      ...execRecord,
      status: "expired",
      resolvedAtMs: execRecord.expiresAtMs,
      reason: "timeout",
    } as const;
    const cancelled = {
      ...pluginRecord,
      status: "cancelled",
      resolvedAtMs: pluginRecord.createdAtMs + 500,
      reason: "run-aborted",
    } as const;

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
    expect(validateApprovalGetParams({ id: pluginRecord.id })).toBe(true);
    expect(validateApprovalGetParams({ id: "" })).toBe(false);
    expect(validateApprovalGetParams({ id: pluginRecord.id, kind: "plugin" })).toBe(false);
    rejectResolve({
      id: "plugin",
      kind: "plugin",
      decision: "deny",
      prefix: true,
    });
    rejectResolve({
      id: "plugin",
      kind: "plugin",
      decision: "deny",
      resolvedBy: "public-actor",
    });
    for (const id of ["\ud800", "\udc00", ".", ".."]) {
      expect(validateApprovalGetParams({ id })).toBe(false);
      rejectResolve({ id, kind: "exec", decision: "deny" });
    }
    expect(validateApprovalGetParams({ id: "approval:🦞/percent%" })).toBe(true);

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
