import { describe, it } from "vitest";
import * as p from "./index.js";
import {
  check,
  schemaValidation,
  validation,
  withOverrides,
} from "./schema/protocol-validation.test-support.js";

const execView = {
  kind: "exec",
  commandText: "git status",
  commandPreview: "git",
  warningText: null,
  host: "gateway",
  nodeId: null,
  agentId: "main",
  allowedDecisions: ["allow-once", "allow-always", "deny"],
};
const pluginView = {
  kind: "plugin",
  title: "Publish",
  description: "Publish 1.2.3",
  severity: "critical",
  pluginId: "publisher",
  toolName: "publish",
  agentId: "release",
  allowedDecisions: ["allow-once", "deny"],
};
const systemView = {
  kind: "system-agent",
  title: "Change",
  description: "Set gateway.port",
  proposalHash: "a".repeat(64),
  agentId: "main",
  allowedDecisions: ["allow-once", "deny"],
};
const exec = withOverrides(execView);
const plugin = withOverrides(pluginView);
const record = {
  id: "approval:123",
  urlPath: "/approve/approval%3A123",
  presentation: execView,
  createdAtMs: 1_780_000_000_000,
  expiresAtMs: 1_780_001_800_000,
};
const pluginItem = {
  ...record,
  id: "plugin:123",
  presentation: pluginView,
};
const pending = { ...record, status: "pending", sourceSessionKey: "agent:worker:subagent:child" };
const terminal = { ...record, resolvedAtMs: record.createdAtMs + 1_000, reason: "user" };
const denied = { ...terminal, status: "denied", decision: "deny" };
const settled = (status: string, reason: string, fields: object = {}) => ({
  ...terminal,
  status,
  reason,
  ...fields,
});
const request = withOverrides({ id: record.id, kind: "exec", decision: "deny" });
const presentation = validation(p.validateApprovalPresentation);
const result = validation((approval) => p.validateApprovalGetResult({ approval }));
const resolve = validation(p.validateApprovalResolveParams);
const get = validation(p.validateApprovalGetParams);
const history = validation(p.validateApprovalHistoryResult);
const paging = validation(p.validateApprovalHistoryParams);
const resolved = validation(p.validateApprovalResolveResult);
const events = schemaValidation(p.SessionApprovalEventSchema);
const event = (phase: string, approval: unknown) => ({
  sessionKey: "agent:main:main",
  sourceSessionKey: pending.sourceSessionKey,
  updatedAtMs: terminal.resolvedAtMs,
  phase,
  approval,
});

describe("unified approval protocol", () => {
  it("accepts only reviewer-safe presentations", () => {
    const external = (fields: object) =>
      plugin({
        externalResolution: { label: "Verify", decisions: ["allow-once"], ...fields },
      });
    const rocket = String.fromCodePoint(0x1f680);
    presentation.accepts(
      execView,
      pluginView,
      systemView,
      { ...external({ decisions: ["allow-once", "allow-always"] }), allowedDecisions: ["deny"] },
      plugin({ detail: "full tool input" }),
      external({ label: rocket.repeat(80) }),
    );
    presentation.rejects(
      plugin({ detail: "" }),
      plugin({ detail: "x".repeat(16_385) }),
      external({ label: "" }),
      external({ label: rocket.repeat(81) }),
      external({ decisions: ["deny"] }),
      external({ proof: "private" }),
    );
    for (const field of ["cwd", "env", "systemRunBinding", "systemRunPlan"]) {
      presentation.rejects(exec({ [field]: field === "env" ? { TOKEN: "secret" } : "private" }));
    }
  });

  it("bounds owner-declared scopes and forbids them on system proposals", () => {
    const scopes = [
      {
        kind: "message-send",
        target: "email",
        recipientCount: 3,
        recipients: ["a@example.com", "b@example.com"],
        audience: "external",
      },
      { kind: "payment", amount: "49.99", currency: "EUR", target: "Stripe" },
      { kind: "external-post", target: "github", visibility: "public" },
    ];
    for (const scope of scopes) {
      presentation.accepts(exec({ scope }), plugin({ scope }));
      presentation.rejects(plugin({ scope: { ...scope, extra: true } }));
    }
    presentation.rejects(
      { ...systemView, scope: scopes[0] },
      plugin({ scope: { ...scopes[0], recipients: Array(6).fill("person@example.com") } }),
    );
  });

  it("requires deny availability and an explicit resolve kind and decision", () => {
    presentation.rejects(
      exec({ allowedDecisions: ["allow-once"] }),
      plugin({ allowedDecisions: ["allow-always"] }),
    );
    resolve.accepts(request({}));
    resolve.rejects({ id: record.id, decision: "deny" }, request({ decision: "accept" }));
  });

  it("accepts only complete channel reviewer facts on every resolve surface", () => {
    const reviewer = { channel: "telegram", accountId: "ops", senderId: "owner" };
    resolve.accepts(request({ reviewer }));
    check(p.validateExecApprovalResolveParams, [{ id: record.id, decision: "deny", reviewer }]);
    check(p.validatePluginApprovalResolveParams, [
      { id: pluginItem.id, decision: "deny", reviewer },
    ]);
    resolve.rejects(request({ reviewer: { channel: "telegram", accountId: "ops" } }));
  });

  it("validates pending and fail-closed terminal states", () => {
    const allowed = { ...terminal, status: "allowed", decision: "allow-once" };
    const expired = settled("expired", "timeout", { resolvedAtMs: record.expiresAtMs });
    result.accepts(
      { ...record, status: "pending" },
      allowed,
      { ...denied, ...pluginItem },
      expired,
      settled("cancelled", "run-aborted", {
        ...pluginItem,
        resolvedAtMs: record.createdAtMs + 500,
      }),
    );
    result.rejects(
      { ...allowed, decision: "deny" },
      { ...allowed, resolvedBy: "device:phone" },
      { ...denied, ...pluginItem, reason: "" },
      { ...expired, decision: "deny" },
      { ...record, presentation: exec({ kind: "plugin" }), status: "pending" },
    );
  });

  it("requires full safe IDs and excludes internal routing state", () => {
    get.accepts({ id: pluginItem.id }, { id: "approval:🦞/percent%" });
    get.rejects({ id: "" }, { id: pluginItem.id, kind: "plugin" });
    resolve.rejects(
      request({ id: "plugin", kind: "plugin", prefix: true }),
      request({ id: "plugin", kind: "plugin", resolvedBy: "public-actor" }),
    );
    for (const id of ["\ud800", "\udc00", ".", ".."]) {
      get.rejects({ id });
      resolve.rejects(request({ id }));
    }
    result.accepts(pending);
    result.rejects({
      ...record,
      status: "pending",
      audienceSessionKeys: [pending.sourceSessionKey, "agent:main"],
    });
  });

  it("validates terminal history pages with optional attribution", () => {
    const item = {
      ...denied,
      ...pluginItem,
      source: { agentId: "release", sessionKey: "agent:release:main" },
      resolver: { kind: "device", id: "reviewer-device" },
    };
    paging.accepts({}, { cursor: "cursor", limit: 50, kind: "plugin" });
    paging.rejects({ limit: 0 }, { limit: 101 }, { kind: "tool" });
    history.accepts({ items: [item], nextCursor: "next" });
    history.rejects({ items: [{ ...record, status: "pending" }] }, { items: [item], extra: true });
  });

  it("returns the recorded terminal snapshot to losing resolvers", () => {
    const approval = { ...terminal, status: "allowed", decision: "allow-always" };
    resolved.accepts({ applied: true, approval }, { applied: false, approval });
    resolved.rejects(
      { applied: false, approval: { ...record, status: "pending" } },
      { applied: false },
    );
  });
});

describe("session approval protocol", () => {
  it("keeps approval subscription opt-in and literal", () => {
    const key = "agent:main:main";
    check(
      p.validateSessionsMessagesSubscribeParams,
      [{ key }, { key, includeApprovals: true }],
      [{ key, includeApprovals: false }],
    );
  });
  it("requires event phase to match the snapshot state", () => {
    events.accepts(event("pending", pending), event("terminal", denied));
    events.rejects(event("pending", denied), event("terminal", pending));
  });
  it.each([
    { status: "denied", decision: "deny", reason: "timeout" },
    { status: "allowed", decision: "allow-once", reason: "timeout" },
    { status: "expired", reason: "user" },
    { status: "cancelled", reason: "timeout" },
  ])("rejects contradictory terminal state %j", (fields) => {
    events.rejects(
      event("terminal", { ...record, resolvedAtMs: terminal.resolvedAtMs, ...fields }),
    );
  });
  it("keeps pending replay authoritative", () => {
    const replay = {
      sessionKey: "agent:main:main",
      updatedAtMs: record.createdAtMs,
      approvals: [pending],
      truncated: false,
    };
    const replays = schemaValidation(p.SessionApprovalReplaySchema);
    replays.accepts(replay);
    replays.rejects({ ...replay, approvals: [denied] });
  });
});
