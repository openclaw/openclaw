import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const createAndRegisterDefaultExecApprovalRequestMock = vi.hoisted(() => vi.fn());
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const buildExecApprovalFollowupTargetMock = vi.hoisted(() => vi.fn(() => null));
const evaluateShellAllowlistMock = vi.hoisted(() =>
  vi.fn(() => ({
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: true,
    segments: [{ resolution: null, argv: ["echo", "ok"] }],
    segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
  })),
);
const hasDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const buildEnforcedShellCommandMock = vi.hoisted(() =>
  vi.fn((): { ok: boolean; reason?: string; command?: string } => ({
    ok: false,
    reason: "segment execution plan unavailable",
  })),
);
const recordAllowlistMatchesUseMock = vi.hoisted(() => vi.fn());
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity: "allowlist",
    hostAsk: "off",
    askFallback: "deny",
  })),
);

vi.mock("../infra/exec-approvals.js", () => ({
  evaluateShellAllowlist: evaluateShellAllowlistMock,
  hasDurableExecApproval: hasDurableExecApprovalMock,
  buildEnforcedShellCommand: buildEnforcedShellCommandMock,
  requiresExecApproval: vi.fn(() => false),
  recordAllowlistUse: vi.fn(),
  recordAllowlistMatchesUse: recordAllowlistMatchesUseMock,
  resolveApprovalAuditCandidatePath: vi.fn(() => null),
  resolveAllowAlwaysPatterns: vi.fn(() => []),
  resolveExecApprovalAllowedDecisions: vi.fn(() => ["allow-once", "allow-always", "deny"]),
  addAllowlistEntry: vi.fn(),
  addDurableCommandApproval: vi.fn(),
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: vi.fn(async () => undefined),
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
  buildExecApprovalFollowupTarget: buildExecApprovalFollowupTargetMock,
  buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
  createExecApprovalDecisionState: vi.fn(() => ({
    baseDecision: { timedOut: false },
    approvedByAsk: false,
    deniedReason: "approval-required",
  })),
  createAndRegisterDefaultExecApprovalRequest: createAndRegisterDefaultExecApprovalRequestMock,
  resolveApprovalDecisionOrUndefined: vi.fn(async () => undefined),
  sendExecApprovalFollowupResult: vi.fn(async () => undefined),
  shouldResolveExecApprovalUnavailableInline: vi.fn(() => false),
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  DEFAULT_NOTIFY_TAIL_CHARS: 1000,
  createApprovalSlug: vi.fn(() => "slug"),
  normalizeNotifyOutput: vi.fn((value) => value),
  runExecProcess: vi.fn(),
}));

vi.mock("./bash-process-registry.js", () => ({
  markBackgrounded: vi.fn(),
  tail: vi.fn((value) => value),
}));

vi.mock("../infra/exec-inline-eval.js", () => ({
  describeInterpreterInlineEval: vi.fn(() => "python -c"),
  detectInterpreterInlineEvalArgv: vi.fn(() => null),
}));

const detectCommandObfuscationMock = vi.hoisted(() =>
  vi.fn(() => ({
    detected: false,
    reasons: [] as string[],
    matchedPatterns: [] as string[],
  })),
);

vi.mock("../infra/exec-obfuscation-detect.js", () => ({
  detectCommandObfuscation: detectCommandObfuscationMock,
  OBFUSCATION_NOT_DETECTED: {
    detected: false,
    reasons: [],
    matchedPatterns: [],
  },
}));

let processGatewayAllowlist: typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist;

describe("processGatewayAllowlist", () => {
  beforeAll(async () => {
    ({ processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js"));
  });

  beforeEach(() => {
    detectCommandObfuscationMock.mockReset();
    detectCommandObfuscationMock.mockReturnValue({
      detected: false,
      reasons: [],
      matchedPatterns: [],
    });
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockReturnValue(null);
    evaluateShellAllowlistMock.mockReset();
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [{ resolution: null, argv: ["echo", "ok"] }],
      segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
    });
    hasDurableExecApprovalMock.mockReset();
    hasDurableExecApprovalMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReset();
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: false,
      reason: "segment execution plan unavailable",
    });
    recordAllowlistMatchesUseMock.mockReset();
    resolveExecHostApprovalContextMock.mockReset();
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
    });
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      details: { status: "approval-pending" },
      content: [],
    });
    createAndRegisterDefaultExecApprovalRequestMock.mockReset();
    createAndRegisterDefaultExecApprovalRequestMock.mockResolvedValue({
      approvalId: "req-1",
      approvalSlug: "slug-1",
      warningText: "",
      expiresAtMs: Date.now() + 60_000,
      preResolvedDecision: null,
      initiatingSurface: "origin",
      sentApproverDms: false,
      unavailableReason: null,
    });
  });

  it("still requires approval when allowlist execution plan is unavailable despite durable trust", async () => {
    const result = await processGatewayAllowlist({
      command: "echo ok",
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "off",
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("allows durable exact-command trust to bypass the synchronous allowlist miss", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: false,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["node", "--version"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: true,
      command: "node --version",
    });

    const result = await processGatewayAllowlist({
      command: "node --version",
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "off",
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result).toEqual({ execCommandOverride: undefined });
  });

  it("keeps denying allowlist misses when durable trust does not match", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: false,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["node", "--version"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);

    await expect(
      processGatewayAllowlist({
        command: "node --version",
        workdir: process.cwd(),
        env: process.env as Record<string, string>,
        pty: false,
        defaultTimeoutSec: 30,
        security: "allowlist",
        ask: "off",
        safeBins: new Set(),
        safeBinProfiles: {},
        warnings: [],
        approvalRunningNoticeMs: 0,
        maxOutput: 1000,
        pendingMaxOutput: 1000,
      }),
    ).rejects.toThrow("exec denied: allowlist miss");
  });

  it("uses sessionKey for followups when notifySessionKey is absent", async () => {
    await processGatewayAllowlist({
      command: "echo ok",
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "off",
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      sessionKey: "agent:main:telegram:direct:123",
    });

    expect(buildExecApprovalFollowupTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });

  it("skips obfuscation detection when obfuscationCheck is false", async () => {
    await processGatewayAllowlist({
      command: "echo ok",
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "off",
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      obfuscationCheck: false,
    });

    expect(detectCommandObfuscationMock).not.toHaveBeenCalled();
  });

  it("runs obfuscation detection by default when obfuscationCheck is not set", async () => {
    await processGatewayAllowlist({
      command: "echo ok",
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "off",
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
    });

    expect(detectCommandObfuscationMock).toHaveBeenCalledWith("echo ok");
  });
});
