import { beforeEach, describe, expect, it, vi } from "vitest";

const createAndRegisterDefaultExecApprovalRequestMock = vi.hoisted(() => vi.fn());
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/exec-approvals.js", () => ({
  evaluateShellAllowlist: vi.fn(() => ({
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: true,
    segments: [{ resolution: null, argv: ["echo", "ok"] }],
    segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
  })),
  hasDurableExecApproval: vi.fn(() => true),
  buildEnforcedShellCommand: vi.fn(() => ({
    ok: false,
    reason: "segment execution plan unavailable",
  })),
  requiresExecApproval: vi.fn(() => false),
  recordAllowlistUse: vi.fn(),
  resolveApprovalAuditCandidatePath: vi.fn(() => null),
  resolveAllowAlwaysPatterns: vi.fn(() => []),
  addAllowlistEntry: vi.fn(),
  addDurableCommandApproval: vi.fn(),
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: vi.fn(async () => undefined),
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: vi.fn(() => ({
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity: "allowlist",
    hostAsk: "off",
    askFallback: "deny",
  })),
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
  buildExecApprovalFollowupTarget: vi.fn(() => null),
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

vi.mock("../infra/exec-obfuscation-detect.js", () => ({
  detectCommandObfuscation: vi.fn(() => ({
    detected: false,
    reasons: [],
    matchedPatterns: [],
  })),
}));

let processGatewayAllowlist: typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist;

describe("processGatewayAllowlist", () => {
  beforeEach(async () => {
    vi.resetModules();
    buildExecApprovalPendingToolResultMock.mockReset();
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
    ({ processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js"));
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
});
