import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/exec-approvals.js", () => ({
  resolveExecApprovals: vi.fn(),
  evaluateShellAllowlist: vi.fn(),
  requiresExecApproval: vi.fn(),
  minSecurity: vi.fn(),
  maxAsk: vi.fn(),
  addAllowlistEntry: vi.fn(),
  recordAllowlistUse: vi.fn(),
  buildSafeBinsShellCommand: vi.fn(),
  buildSafeShellCommand: vi.fn(),
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  requestExecApprovalDecision: vi.fn(),
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  emitExecSystemEvent: vi.fn(),
  runExecProcess: vi.fn(),
  DEFAULT_APPROVAL_TIMEOUT_MS: 120_000,
  DEFAULT_NOTIFY_TAIL_CHARS: 2000,
  createApprovalSlug: (id: string) => id.slice(0, 8),
  normalizeNotifyOutput: (s: string) => s,
}));

vi.mock("./bash-process-registry.js", () => ({
  markBackgrounded: vi.fn(),
  tail: (s: string) => s,
}));

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

function makeDefaultParams() {
  return {
    command: "echo test",
    workdir: "/tmp",
    env: {},
    pty: false,
    defaultTimeoutSec: 60,
    security: "allowlist" as const,
    ask: "always" as const,
    safeBins: new Set<string>(),
    agentId: "main",
    sessionKey: "session-1",
    scopeKey: "scope",
    warnings: [] as string[],
    notifySessionKey: "session-1",
    approvalRunningNoticeMs: 0,
    maxOutput: 10000,
    pendingMaxOutput: 10000,
  };
}

describe("approval timeout denial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("denies on approval timeout when askFallback is not allowlist", async () => {
    const {
      resolveExecApprovals,
      evaluateShellAllowlist,
      requiresExecApproval,
      minSecurity,
      maxAsk,
    } = await import("../infra/exec-approvals.js");
    const { requestExecApprovalDecision } = await import("./bash-tools.exec-approval-request.js");
    const { emitExecSystemEvent } = await import("./bash-tools.exec-runtime.js");

    vi.mocked(resolveExecApprovals).mockReturnValue({
      file: "/tmp/approvals.json",
      agent: { security: "allowlist", ask: "always", askFallback: "deny" },
      allowlist: [],
    } as unknown as ReturnType<typeof resolveExecApprovals>);

    vi.mocked(minSecurity).mockReturnValue("allowlist");
    vi.mocked(maxAsk).mockReturnValue("always");
    vi.mocked(evaluateShellAllowlist).mockReturnValue({
      analysisOk: true,
      allowlistSatisfied: false,
      allowlistMatches: [],
      segments: [],
    } as unknown as ReturnType<typeof evaluateShellAllowlist>);
    vi.mocked(requiresExecApproval).mockReturnValue(true);
    vi.mocked(requestExecApprovalDecision).mockResolvedValue(null);

    const { processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js");
    const result = await processGatewayAllowlist(makeDefaultParams());

    expect(result.pendingResult).toBeDefined();
    expect(result.pendingResult?.details?.status).toBe("approval-pending");

    await flushAsync();

    expect(emitExecSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("approval-timeout"),
      expect.objectContaining({ sessionKey: "session-1" }),
    );
  });

  it("denies on approval timeout with allowlist fallback when allowlist not satisfied", async () => {
    const {
      resolveExecApprovals,
      evaluateShellAllowlist,
      requiresExecApproval,
      minSecurity,
      maxAsk,
    } = await import("../infra/exec-approvals.js");
    const { requestExecApprovalDecision } = await import("./bash-tools.exec-approval-request.js");
    const { emitExecSystemEvent } = await import("./bash-tools.exec-runtime.js");

    vi.mocked(resolveExecApprovals).mockReturnValue({
      file: "/tmp/approvals.json",
      agent: { security: "allowlist", ask: "always", askFallback: "allowlist" },
      allowlist: [],
    } as unknown as ReturnType<typeof resolveExecApprovals>);

    vi.mocked(minSecurity).mockReturnValue("allowlist");
    vi.mocked(maxAsk).mockReturnValue("always");
    vi.mocked(evaluateShellAllowlist).mockReturnValue({
      analysisOk: true,
      allowlistSatisfied: false,
      allowlistMatches: [],
      segments: [],
    } as unknown as ReturnType<typeof evaluateShellAllowlist>);
    vi.mocked(requiresExecApproval).mockReturnValue(true);
    vi.mocked(requestExecApprovalDecision).mockResolvedValue(null);

    const { processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js");
    await processGatewayAllowlist(makeDefaultParams());
    await flushAsync();

    expect(emitExecSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("approval-timeout (allowlist-miss)"),
      expect.objectContaining({ sessionKey: "session-1" }),
    );
  });

  it("approves on timeout with allowlist fallback when allowlist is satisfied", async () => {
    const {
      resolveExecApprovals,
      evaluateShellAllowlist,
      requiresExecApproval,
      minSecurity,
      maxAsk,
    } = await import("../infra/exec-approvals.js");
    const { requestExecApprovalDecision } = await import("./bash-tools.exec-approval-request.js");
    const { emitExecSystemEvent, runExecProcess } = await import("./bash-tools.exec-runtime.js");

    vi.mocked(resolveExecApprovals).mockReturnValue({
      file: "/tmp/approvals.json",
      agent: { security: "allowlist", ask: "always", askFallback: "allowlist" },
      allowlist: [],
    } as unknown as ReturnType<typeof resolveExecApprovals>);

    vi.mocked(minSecurity).mockReturnValue("allowlist");
    vi.mocked(maxAsk).mockReturnValue("always");
    vi.mocked(evaluateShellAllowlist).mockReturnValue({
      analysisOk: true,
      allowlistSatisfied: true,
      allowlistMatches: [{ pattern: "/usr/bin/echo", type: "exact" }],
      segments: [{ resolution: { resolvedPath: "/usr/bin/echo" } }],
    } as unknown as ReturnType<typeof evaluateShellAllowlist>);
    vi.mocked(requiresExecApproval).mockReturnValue(true);
    vi.mocked(requestExecApprovalDecision).mockResolvedValue(null);

    const mockSession = { id: "test-session" };
    vi.mocked(runExecProcess).mockResolvedValue({
      session: mockSession,
      promise: Promise.resolve({ aggregated: "output", exitCode: 0, timedOut: false }),
    } as unknown as Awaited<ReturnType<typeof runExecProcess>>);

    const { processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js");
    await processGatewayAllowlist(makeDefaultParams());
    await flushAsync();

    expect(runExecProcess).toHaveBeenCalled();
    const denialCalls = vi
      .mocked(emitExecSystemEvent)
      .mock.calls.filter(([msg]) => typeof msg === "string" && msg.includes("denied"));
    expect(denialCalls).toHaveLength(0);
  });

  it("denies when user explicitly denies", async () => {
    const {
      resolveExecApprovals,
      evaluateShellAllowlist,
      requiresExecApproval,
      minSecurity,
      maxAsk,
    } = await import("../infra/exec-approvals.js");
    const { requestExecApprovalDecision } = await import("./bash-tools.exec-approval-request.js");
    const { emitExecSystemEvent } = await import("./bash-tools.exec-runtime.js");

    vi.mocked(resolveExecApprovals).mockReturnValue({
      file: "/tmp/approvals.json",
      agent: { security: "allowlist", ask: "always", askFallback: "deny" },
      allowlist: [],
    } as unknown as ReturnType<typeof resolveExecApprovals>);

    vi.mocked(minSecurity).mockReturnValue("allowlist");
    vi.mocked(maxAsk).mockReturnValue("always");
    vi.mocked(evaluateShellAllowlist).mockReturnValue({
      analysisOk: true,
      allowlistSatisfied: false,
      allowlistMatches: [],
      segments: [],
    } as unknown as ReturnType<typeof evaluateShellAllowlist>);
    vi.mocked(requiresExecApproval).mockReturnValue(true);
    vi.mocked(requestExecApprovalDecision).mockResolvedValue("deny");

    const { processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js");
    await processGatewayAllowlist(makeDefaultParams());
    await flushAsync();

    expect(emitExecSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("user-denied"),
      expect.objectContaining({ sessionKey: "session-1" }),
    );
  });
});
