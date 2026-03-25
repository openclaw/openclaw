import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildExecApprovalPendingToolResult,
  createExecApprovalDecisionState,
  createExecApprovalPendingState,
  createExecApprovalRequestState,
  resolveBaseExecApprovalDecision,
} from "./bash-tools.exec-host-shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnabledSurface(channelLabel = "WhatsApp") {
  return {
    kind: "enabled" as const,
    channel: "whatsapp",
    channelLabel,
  };
}

function makeDisabledSurface(channelLabel = "Slack") {
  return {
    kind: "disabled" as const,
    channel: "slack",
    channelLabel,
  };
}

function makeUnsupportedSurface(channelLabel = "Email") {
  return {
    kind: "unsupported" as const,
    channel: "email",
    channelLabel,
  };
}

function makePendingToolResultParams(
  overrides: Partial<Parameters<typeof buildExecApprovalPendingToolResult>[0]> = {},
): Parameters<typeof buildExecApprovalPendingToolResult>[0] {
  return {
    host: "gateway",
    command: "echo hello",
    cwd: "/tmp",
    warningText: "",
    approvalId: "test-approval-uuid",
    approvalSlug: "abc123",
    expiresAtMs: Date.now() + 60_000,
    initiatingSurface: makeEnabledSurface(),
    sentApproverDms: false,
    unavailableReason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveBaseExecApprovalDecision
// ---------------------------------------------------------------------------

describe("resolveBaseExecApprovalDecision", () => {
  it('returns user-denied when decision is "deny"', () => {
    const result = resolveBaseExecApprovalDecision({
      decision: "deny",
      askFallback: "allowlist",
      obfuscationDetected: false,
    });

    expect(result).toEqual({
      approvedByAsk: false,
      deniedReason: "user-denied",
      timedOut: false,
    });
  });

  it("returns user-denied even when obfuscation is detected alongside deny decision", () => {
    const result = resolveBaseExecApprovalDecision({
      decision: "deny",
      askFallback: "full",
      obfuscationDetected: true,
    });

    expect(result).toEqual({
      approvedByAsk: false,
      deniedReason: "user-denied",
      timedOut: false,
    });
  });

  it("returns approval-timeout with obfuscation label when decision is null and obfuscation detected", () => {
    const result = resolveBaseExecApprovalDecision({
      decision: null,
      askFallback: "full",
      obfuscationDetected: true,
    });

    expect(result).toEqual({
      approvedByAsk: false,
      deniedReason: "approval-timeout (obfuscation-detected)",
      timedOut: true,
    });
  });

  it('returns approved when decision is null and askFallback is "full"', () => {
    const result = resolveBaseExecApprovalDecision({
      decision: null,
      askFallback: "full",
      obfuscationDetected: false,
    });

    expect(result).toEqual({
      approvedByAsk: true,
      deniedReason: null,
      timedOut: true,
    });
  });

  it('returns approval-timeout denial when decision is null and askFallback is "deny"', () => {
    const result = resolveBaseExecApprovalDecision({
      decision: null,
      askFallback: "deny",
      obfuscationDetected: false,
    });

    expect(result).toEqual({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
      timedOut: true,
    });
  });

  it('returns default timeout (not approved, no denial) when decision is null and askFallback is "allowlist"', () => {
    const result = resolveBaseExecApprovalDecision({
      decision: null,
      askFallback: "allowlist",
      obfuscationDetected: false,
    });

    expect(result).toEqual({
      approvedByAsk: false,
      deniedReason: null,
      timedOut: true,
    });
  });

  it("returns not-approved with no denial for any non-deny non-null decision string", () => {
    const result = resolveBaseExecApprovalDecision({
      decision: "allow-once",
      askFallback: "deny",
      obfuscationDetected: false,
    });

    expect(result).toEqual({
      approvedByAsk: false,
      deniedReason: null,
      timedOut: false,
    });
  });

  it("treats empty-string decision the same as null (falls into timeout branch)", () => {
    const result = resolveBaseExecApprovalDecision({
      decision: "",
      askFallback: "deny",
      obfuscationDetected: false,
    });

    // "" is falsy — falls into the no-decision (timeout) branch
    expect(result).toEqual({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
      timedOut: true,
    });
  });
});

// ---------------------------------------------------------------------------
// createExecApprovalPendingState
// ---------------------------------------------------------------------------

describe("createExecApprovalPendingState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets expiresAtMs to Date.now() + timeoutMs", () => {
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));

    const now = Date.now();
    const result = createExecApprovalPendingState({ warnings: [], timeoutMs: 30_000 });

    expect(result.expiresAtMs).toBe(now + 30_000);
  });

  it("joins warnings with newlines and appends double newline", () => {
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));

    const result = createExecApprovalPendingState({
      warnings: ["Warning one", "Warning two"],
      timeoutMs: 5_000,
    });

    expect(result.warningText).toBe("Warning one\nWarning two\n\n");
  });

  it("sets warningText to empty string when no warnings", () => {
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));

    const result = createExecApprovalPendingState({ warnings: [], timeoutMs: 5_000 });

    expect(result.warningText).toBe("");
  });

  it("sets preResolvedDecision to undefined", () => {
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));

    const result = createExecApprovalPendingState({ warnings: [], timeoutMs: 5_000 });

    expect(result.preResolvedDecision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createExecApprovalRequestState
// ---------------------------------------------------------------------------

describe("createExecApprovalRequestState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes all pending state fields plus noticeSeconds", () => {
    const result = createExecApprovalRequestState({
      warnings: ["warn"],
      timeoutMs: 60_000,
      approvalRunningNoticeMs: 10_000,
    });

    expect(result).toMatchObject({
      warningText: "warn\n\n",
      expiresAtMs: Date.now() + 60_000,
      preResolvedDecision: undefined,
      noticeSeconds: 10,
    });
  });

  it("rounds approvalRunningNoticeMs to nearest second", () => {
    const result = createExecApprovalRequestState({
      warnings: [],
      timeoutMs: 30_000,
      approvalRunningNoticeMs: 7_600,
    });

    expect(result.noticeSeconds).toBe(8);
  });

  it("clamps noticeSeconds to minimum of 1 when approvalRunningNoticeMs is 0", () => {
    const result = createExecApprovalRequestState({
      warnings: [],
      timeoutMs: 30_000,
      approvalRunningNoticeMs: 0,
    });

    expect(result.noticeSeconds).toBe(1);
  });

  it("clamps noticeSeconds to 1 for sub-500ms values", () => {
    const result = createExecApprovalRequestState({
      warnings: [],
      timeoutMs: 30_000,
      approvalRunningNoticeMs: 400,
    });

    expect(result.noticeSeconds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createExecApprovalDecisionState
// ---------------------------------------------------------------------------

describe("createExecApprovalDecisionState", () => {
  it("exposes baseDecision alongside approvedByAsk and deniedReason", () => {
    const result = createExecApprovalDecisionState({
      decision: "deny",
      askFallback: "allowlist",
      obfuscationDetected: false,
    });

    expect(result.baseDecision).toEqual({
      approvedByAsk: false,
      deniedReason: "user-denied",
      timedOut: false,
    });
    expect(result.approvedByAsk).toBe(false);
    expect(result.deniedReason).toBe("user-denied");
  });

  it("treats undefined decision as null (falls into timeout path)", () => {
    const result = createExecApprovalDecisionState({
      decision: undefined,
      askFallback: "full",
      obfuscationDetected: false,
    });

    expect(result.approvedByAsk).toBe(true);
    expect(result.deniedReason).toBeNull();
    expect(result.baseDecision.timedOut).toBe(true);
  });

  it("returns not-approved with no denial for an allow decision", () => {
    const result = createExecApprovalDecisionState({
      decision: "allow-once",
      askFallback: "deny",
      obfuscationDetected: false,
    });

    expect(result.approvedByAsk).toBe(false);
    expect(result.deniedReason).toBeNull();
    expect(result.baseDecision.timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildExecApprovalPendingToolResult
// ---------------------------------------------------------------------------

describe("buildExecApprovalPendingToolResult", () => {
  describe("when unavailableReason is null (approval pending branch)", () => {
    it("produces a text content item and approval-pending details", () => {
      const params = makePendingToolResultParams({ unavailableReason: null });
      const result = buildExecApprovalPendingToolResult(params);

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(result.details).toMatchObject({
        status: "approval-pending",
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        expiresAtMs: params.expiresAtMs,
        host: params.host,
        command: params.command,
        cwd: params.cwd,
      });
    });

    it("includes approval id and slug in the message text", () => {
      const params = makePendingToolResultParams({
        unavailableReason: null,
        approvalId: "full-uuid-1234",
        approvalSlug: "xyz789",
      });
      const result = buildExecApprovalPendingToolResult(params);
      const text = (result.content[0] as { text?: string }).text ?? "";

      expect(text).toContain("xyz789");
      expect(text).toContain("full-uuid-1234");
    });

    it("includes nodeId in details when provided", () => {
      const params = makePendingToolResultParams({
        unavailableReason: null,
        host: "node",
        nodeId: "node-99",
      });
      const result = buildExecApprovalPendingToolResult(params);

      expect(result.details).toMatchObject({
        status: "approval-pending",
        nodeId: "node-99",
        host: "node",
      });
    });

    it("includes warningText in pending details", () => {
      const params = makePendingToolResultParams({
        unavailableReason: null,
        warningText: "Dangerous command!\n\n",
      });
      const result = buildExecApprovalPendingToolResult(params);

      expect(result.details).toMatchObject({
        status: "approval-pending",
        warningText: "Dangerous command!\n\n",
      });
    });

    it("includes warningText in message when set", () => {
      const params = makePendingToolResultParams({
        unavailableReason: null,
        warningText: "Watch out\n\n",
      });
      const result = buildExecApprovalPendingToolResult(params);
      const text = (result.content[0] as { text?: string }).text ?? "";

      expect(text).toContain("Watch out");
    });
  });

  describe("when unavailableReason is set (approval unavailable branch)", () => {
    it("produces approval-unavailable details for no-approval-route", () => {
      const params = makePendingToolResultParams({ unavailableReason: "no-approval-route" });
      const result = buildExecApprovalPendingToolResult(params);

      expect(result.details).toMatchObject({
        status: "approval-unavailable",
        reason: "no-approval-route",
        host: params.host,
        command: params.command,
        cwd: params.cwd,
      });
    });

    it("produces approval-unavailable details for initiating-platform-disabled", () => {
      const params = makePendingToolResultParams({
        unavailableReason: "initiating-platform-disabled",
        initiatingSurface: makeDisabledSurface("Slack"),
      });
      const result = buildExecApprovalPendingToolResult(params);

      expect(result.details).toMatchObject({
        status: "approval-unavailable",
        reason: "initiating-platform-disabled",
        channelLabel: "Slack",
      });
    });

    it("produces approval-unavailable details for initiating-platform-unsupported", () => {
      const params = makePendingToolResultParams({
        unavailableReason: "initiating-platform-unsupported",
        initiatingSurface: makeUnsupportedSurface("Email"),
      });
      const result = buildExecApprovalPendingToolResult(params);

      expect(result.details).toMatchObject({
        status: "approval-unavailable",
        reason: "initiating-platform-unsupported",
        channelLabel: "Email",
      });
    });

    it("includes sentApproverDms in details", () => {
      const params = makePendingToolResultParams({
        unavailableReason: "initiating-platform-disabled",
        initiatingSurface: makeDisabledSurface("Slack"),
        sentApproverDms: true,
      });
      const result = buildExecApprovalPendingToolResult(params);

      expect(result.details).toMatchObject({
        status: "approval-unavailable",
        sentApproverDms: true,
      });
    });

    it("includes nodeId in details when provided", () => {
      const params = makePendingToolResultParams({
        unavailableReason: "no-approval-route",
        host: "node",
        nodeId: "node-42",
      });
      const result = buildExecApprovalPendingToolResult(params);

      expect(result.details).toMatchObject({
        status: "approval-unavailable",
        nodeId: "node-42",
        host: "node",
      });
    });

    it("produces a text content item with a non-empty message", () => {
      const params = makePendingToolResultParams({ unavailableReason: "no-approval-route" });
      const result = buildExecApprovalPendingToolResult(params);

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({ type: "text" });
      const text = (result.content[0] as { text?: string }).text ?? "";
      expect(text.length).toBeGreaterThan(0);
    });

    it("message mentions platform-specific channel label for disabled surface", () => {
      const params = makePendingToolResultParams({
        unavailableReason: "initiating-platform-disabled",
        initiatingSurface: makeDisabledSurface("Slack"),
        sentApproverDms: false,
      });
      const result = buildExecApprovalPendingToolResult(params);
      const text = (result.content[0] as { text?: string }).text ?? "";

      // buildExecApprovalUnavailableReplyPayload should mention the channelLabel
      expect(text).toContain("Slack");
    });
  });
});
