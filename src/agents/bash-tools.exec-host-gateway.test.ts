import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import type {
  ExecAllowlistEntry,
  ExecApprovalDecision,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecAsk,
  ExecCommandSegment,
  ExecSecurity,
  ExecSegmentSatisfiedBy,
} from "../infra/exec-approvals.js";
import {
  planShellAuthorization,
  type ExecAuthorizationPlan,
} from "../infra/exec-authorization-plan.js";
import { buildAuthorizedShellCommandFromPlan } from "../infra/exec-authorization-render.js";
import {
  buildCwdBoundHashedArgPattern,
  resolvePolicyTargetCandidatePath,
} from "../infra/exec-command-resolution.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { expectNoCalls } from "../test-utils/mock-call-assertions.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { captureProcessUnhandledRejections } from "./bash-tools.exec-runtime.test-support.js";
import type {
  ExecApprovalFollowupFactory,
  ExecApprovalFollowupOutcome,
} from "./bash-tools.exec-types.js";
import { captureSecurityEvents } from "./test-helpers/security-events.js";

type SendExecApprovalFollowupResult =
  typeof import("./bash-tools.exec-host-shared.js").sendExecApprovalFollowupResult;
type ExecAutoReviewer = typeof import("../infra/exec-auto-review.js").defaultExecAutoReviewer;
type MockAllowlistSegment = Omit<ExecCommandSegment, "raw"> & { raw?: string };
type MockAllowlistResult = {
  allowlistMatches: unknown[];
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  segments: MockAllowlistSegment[];
  segmentAllowlistEntries: unknown[];
  segmentSatisfiedBy?: ExecSegmentSatisfiedBy[];
  authorizationPlan?: ExecAuthorizationPlan;
};
type MockExecHostApprovalContext = {
  approvals: {
    allowlist: ExecAllowlistEntry[];
    file: ExecApprovalsFile;
    agent?: Required<ExecApprovalsDefaults>;
  };
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback?: ExecSecurity;
};

const INLINE_EVAL_HIT = {
  executable: "python3",
  normalizedExecutable: "python3",
  flag: "-c",
  argv: ["python3", "-c", "print(1)"],
};

function exactCommandMarker(command: string): string {
  return `=command:${crypto.createHash("sha256").update(command.trim()).digest("hex").slice(0, 16)}`;
}

const pendingResultMock = vi.hoisted(() => vi.fn());
const allowlistMock = vi.hoisted(() => vi.fn<() => MockAllowlistResult>());
const durableApprovalMock = vi.hoisted(() => vi.fn(() => true));
const exactApprovalMock = vi.hoisted(() => vi.fn(() => false));
const requiresApprovalMock = vi.hoisted(() => vi.fn(() => false));
const enforcedCommandMock = vi.hoisted(() =>
  vi.fn<() => { ok: boolean; reason?: string; command?: string }>(),
);
const reviewerMock = vi.hoisted(() => vi.fn<ExecAutoReviewer>());
const commitAuthorizationMock = vi.hoisted(() =>
  vi.fn<typeof import("../infra/exec-approvals.js").commitExecAuthorizationLocked>(
    async () => () => {},
  ),
);
const approvalDecisionMock = vi.hoisted(() =>
  vi.fn<() => Promise<string | null | undefined>>(async () => undefined),
);
const runAbortedApprovalError = vi.hoisted(() => new Error("run aborted"));
const approvalRouteFixture = vi.hoisted(() => ({ inline: false, id: "" }));
const gatewayMock = vi.hoisted(() =>
  vi.fn(async (method: string, _options: unknown, params: { id: string }) => {
    if (method === "exec.approval.request") {
      approvalRouteFixture.id = params.id;
      return approvalRouteFixture.inline ? { decision: null } : { status: "accepted" };
    }
    if (method !== "exec.approval.waitDecision") {
      throw new Error(`Unexpected gateway method: ${method}`);
    }
    try {
      const decision = await approvalDecisionMock();
      if (decision === undefined) {
        throw new Error("approval request failed");
      }
      return { decision };
    } catch (error) {
      if (error === runAbortedApprovalError) {
        return { terminalReason: "run-aborted" };
      }
      throw error;
    }
  }),
);
const hostPolicyMock = vi.hoisted(() => vi.fn<() => MockExecHostApprovalContext>());
const runExecProcessMock = vi.hoisted(() => vi.fn());
const startupCancellationMocks = vi.hoisted(() => ({
  spawn: vi.fn<ProcessSupervisor["spawn"]>(),
  prepare: vi.fn<() => void>(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: startupCancellationMocks.spawn }),
}));

vi.mock("./shell-snapshot.js", () => ({
  maybeWrapCommandWithShellSnapshot: async (input: { command: string }) => {
    startupCancellationMocks.prepare();
    return input.command;
  },
}));

const markBackgroundedMock = vi.hoisted(() => vi.fn());
const followupMock = vi.hoisted(() => vi.fn<SendExecApprovalFollowupResult>(async () => undefined));
const approvalRouteMock = vi.hoisted(() =>
  vi.fn<typeof import("./bash-tools.exec-host-shared.js").createExecApprovalRequestRoute>(),
);
const inlineEvalMock = vi.hoisted(() => vi.fn<() => typeof INLINE_EVAL_HIT | null>());

vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  evaluateShellAllowlistWithAuthorization: allowlistMock,
  hasDurableExecApproval: durableApprovalMock,
  hasExactCommandDurableExecApproval: exactApprovalMock,
  buildEnforcedShellCommand: enforcedCommandMock,
  requiresExecApproval: requiresApprovalMock,
  commitExecAuthorizationLocked: commitAuthorizationMock,
  resolveApprovalAuditTrustPath: vi.fn(() => null),
  resolveAllowAlwaysPatterns: vi.fn(() => []),
}));

vi.mock("../infra/exec-auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-auto-review.js")>()),
  defaultExecAutoReviewer: reviewerMock,
}));

// mock-isolation: Keep Gateway transport and credential loading inert while testing local approval ownership.
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: gatewayMock,
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("./bash-tools.exec-host-shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bash-tools.exec-host-shared.js")>();
  approvalRouteMock.mockImplementation(actual.createExecApprovalRequestRoute);
  return {
    ...actual,
    resolveExecHostApprovalContext: hostPolicyMock,
    buildExecApprovalPendingToolResult: pendingResultMock,
    createExecApprovalRequestRoute: approvalRouteMock,
    sendExecApprovalFollowupResult: followupMock,
  };
});

vi.mock("./bash-tools.exec-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-runtime.js")>()),
  createApprovalSlug: vi.fn(() => "slug"),
  runExecProcess: runExecProcessMock,
}));

vi.mock("./bash-process-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-process-registry.js")>()),
  getActiveBackgroundExecSessionCount: vi.fn(() => 0),
  markBackgrounded: markBackgroundedMock,
  tail: vi.fn((value) => value),
}));

vi.mock("../infra/command-analysis/inline-eval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/command-analysis/inline-eval.js")>()),
  describeInterpreterInlineEval: vi.fn(() => "python -c"),
  detectInterpreterInlineEvalArgv: inlineEvalMock,
}));

let processGatewayAllowlist: typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist;
type GatewayAllowlistParams = Parameters<typeof processGatewayAllowlist>[0];
type GatewayResult = Awaited<ReturnType<typeof processGatewayAllowlist>>;

const expectCall = (mock: unknown, fields: object) =>
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));

function expectAuthorization(fields: object) {
  expectCall(commitAuthorizationMock, {
    authorization: expect.objectContaining(fields),
  });
}

const expectPending = (result: GatewayResult) =>
  expect(result.pendingResult?.details.status).toBe("approval-pending");

const completedOutcome = (aggregated = "done"): ExecApprovalFollowupOutcome => ({
  status: "completed",
  exitCode: 0,
  timedOut: false,
  aggregated,
});

const requireSentFollowupText = (callIndex = 0): string =>
  followupMock.mock.calls[callIndex]?.[1] ?? "";

describe("processGatewayAllowlist", () => {
  beforeAll(async () => {
    ({ processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js"));
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetDiagnosticEventsForTest();
    pendingResultMock.mockReset();
    allowlistMock.mockReset();
    mockAllowlist({
      allowlistSatisfied: true,
      segments: [{ resolution: null, argv: ["echo", "ok"] }],
      segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
      segmentSatisfiedBy: [],
    });
    durableApprovalMock.mockReset().mockReturnValue(true);
    exactApprovalMock.mockReset().mockReturnValue(false);
    requiresApprovalMock.mockReset().mockReturnValue(false);
    enforcedCommandMock.mockReset().mockReturnValue({
      ok: false,
      reason: "segment execution plan unavailable",
    });
    reviewerMock.mockReset().mockResolvedValue({
      decision: "allow-once",
      risk: "low",
      rationale: "allowed",
    });
    commitAuthorizationMock.mockReset();
    approvalDecisionMock.mockReset().mockResolvedValue(undefined);
    approvalRouteFixture.inline = false;
    gatewayMock.mockClear();
    approvalRouteFixture.id = "";
    hostPolicyMock.mockReset();
    mockHostPolicy();
    runExecProcessMock.mockReset();
    startupCancellationMocks.spawn.mockReset();
    startupCancellationMocks.prepare.mockReset();
    markBackgroundedMock.mockReset();
    followupMock.mockReset();
    inlineEvalMock.mockReset().mockReturnValue(null);
    pendingResultMock.mockReturnValue({
      details: { status: "approval-pending" },
      content: [],
    });
    approvalRouteMock.mockClear();
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    resetGatewayWorkAdmission();
  });

  function mockHostPolicy(overrides: Partial<MockExecHostApprovalContext> = {}) {
    hostPolicyMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
      ...overrides,
    });
  }

  function mockAllowlist(overrides: Partial<MockAllowlistResult> = {}) {
    allowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [],
      segmentAllowlistEntries: [],
      ...overrides,
    });
  }

  function runGatewayAllowlist(
    overrides: Partial<GatewayAllowlistParams> & Pick<GatewayAllowlistParams, "command">,
  ) {
    return processGatewayAllowlist({
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
      ...overrides,
    });
  }

  function mockApprovedDetachedExec(params: {
    outcome: ExecApprovalFollowupOutcome;
    sessionId?: string;
  }) {
    approvalDecisionMock.mockResolvedValueOnce("allow-once");
    runExecProcessMock.mockResolvedValue({
      session: { id: params.sessionId ?? "sess-1" },
      promise: Promise.resolve(params.outcome),
    });
  }

  function mockCompletedProcess(aggregated = "done", sessionId = "sess-1") {
    runExecProcessMock.mockResolvedValue({
      session: { id: sessionId },
      promise: Promise.resolve(completedOutcome(aggregated)),
    });
  }

  async function runDetached(overrides: Partial<GatewayAllowlistParams> = {}) {
    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      turnSourceChannel: "webchat",
      approvalFollowupMode: "agent",
      ...overrides,
    });
    expectPending(result);
  }

  const waitForFollowup = () => vi.waitFor(() => expect(followupMock).toHaveBeenCalledOnce());

  function mockExactTrust(command: string, entries: ExecAllowlistEntry[] = []) {
    durableApprovalMock.mockReturnValue(true);
    exactApprovalMock.mockReturnValue(true);
    mockHostPolicy({
      approvals: {
        allowlist: [...entries, { pattern: exactCommandMarker(command), source: "allow-always" }],
        file: { version: 1, agents: {} },
      },
    });
  }

  async function requireAuthorizationPlan(params: Parameters<typeof planShellAuthorization>[0]) {
    const authorizationPlan = await planShellAuthorization(params);
    if (!authorizationPlan.ok) {
      throw new Error(authorizationPlan.reason);
    }
    return authorizationPlan;
  }

  async function planAllowlistedNodeVersion() {
    const command = "node --version";
    const authorizationPlan = await requireAuthorizationPlan({ command, env: process.env });
    const segments = authorizationPlan.groups.flatMap((group) =>
      group.candidates.map((candidate) => candidate.sourceSegment),
    );
    const enforced = buildAuthorizedShellCommandFromPlan({
      plan: authorizationPlan,
      mode: "enforced",
      segmentSatisfiedBy: ["allowlist"],
    });
    if (!enforced.ok) {
      throw new Error(enforced.reason);
    }
    return { command, authorizationPlan, segments, enforcedCommand: enforced.command };
  }

  async function mockAllowlistTimeoutFallback(hostSecurity: ExecSecurity) {
    const { command, authorizationPlan, segments, enforcedCommand } =
      await planAllowlistedNodeVersion();
    const policyPath = resolvePolicyTargetCandidatePath(segments[0]?.resolution ?? null) ?? "node";
    requiresApprovalMock.mockReturnValue(true);
    enforcedCommandMock.mockReturnValue({ ok: true, command: enforcedCommand });
    mockAllowlist({
      allowlistMatches: [{ pattern: policyPath }],
      allowlistSatisfied: true,
      segments,
      segmentAllowlistEntries: [{ pattern: policyPath }],
      segmentSatisfiedBy: ["allowlist"],
      authorizationPlan,
    });
    mockHostPolicy({ hostSecurity, hostAsk: "always", askFallback: "allowlist" });
    return { command, enforcedCommand };
  }

  async function configurePlanBackedCommand(params: {
    command: string;
    env?: NodeJS.ProcessEnv;
    allowlistSatisfied?: boolean;
    allowlistMatches?: unknown[];
    requiresApproval?: boolean;
    satisfiedBy?: ExecSegmentSatisfiedBy;
    segmentSatisfiedBy?: ExecSegmentSatisfiedBy[];
    segmentAllowlistEntries?: unknown[];
    hostAsk?: "off" | "on-miss" | "always";
    askFallback?: "deny" | "allowlist" | "full";
  }) {
    const authorizationPlan = await requireAuthorizationPlan({
      command: params.command,
      env: params.env ?? process.env,
    });
    const segments = authorizationPlan.groups.flatMap((group) =>
      group.candidates.map((entry) => entry.sourceSegment),
    );
    requiresApprovalMock.mockReturnValue(params.requiresApproval ?? true);
    mockAllowlist({
      allowlistSatisfied: params.allowlistSatisfied ?? false,
      allowlistMatches: params.allowlistMatches ?? [],
      segments,
      segmentAllowlistEntries: params.segmentAllowlistEntries ?? [],
      segmentSatisfiedBy:
        params.segmentSatisfiedBy ?? segments.map(() => params.satisfiedBy ?? null),
      authorizationPlan,
    });
    mockHostPolicy({
      hostAsk: params.hostAsk ?? "on-miss",
      askFallback: params.askFallback ?? "deny",
    });
    const [candidate] = authorizationPlan.groups.flatMap((group) => group.candidates);
    const resolvedPath =
      candidate?.sourceSegment.resolution?.execution.resolvedRealPath ??
      candidate?.sourceSegment.resolution?.execution.resolvedPath;
    const invocationPath =
      candidate?.sourceSegment.resolution?.execution.resolvedPath ?? resolvedPath;
    return { authorizationPlan, resolvedPath, invocationPath };
  }

  it("denies shell-expansion plan misses immediately when asking is off and fallback denies", async () => {
    const command = "grep -il needle -r /tmp --include=*.md";
    const authorizationPlan = await requireAuthorizationPlan({
      command,
      env: { PATH: "/usr/bin:/bin" },
    });
    const segments = authorizationPlan.groups.flatMap((group) =>
      group.candidates.map((candidate) => candidate.sourceSegment),
    );
    mockAllowlist({
      allowlistMatches: [{ pattern: "/usr/bin/grep" }],
      allowlistSatisfied: true,
      segments,
      segmentAllowlistEntries: [{ pattern: "/usr/bin/grep" }],
      segmentSatisfiedBy: ["allowlist"],
      authorizationPlan,
    });
    const captured = captureSecurityEvents();

    let result: Awaited<ReturnType<typeof runGatewayAllowlist>>;
    try {
      result = await runGatewayAllowlist({ command });
    } finally {
      captured.stop();
    }

    expect(approvalRouteMock).not.toHaveBeenCalled();
    expect(result!.deniedResult?.content[0]).toMatchObject({
      text: expect.stringContaining("ask-fallback-deny: execution-plan-miss"),
    });
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "exec.approval.denied",
      outcome: "denied",
      reason: "ask-fallback-deny: execution-plan-miss",
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects a durable grant when its approved directory is replaced before execution",
    async () => {
      const { command, authorizationPlan, segments, enforcedCommand } =
        await planAllowlistedNodeVersion();
      mockAllowlist({
        allowlistMatches: [{ pattern: "/usr/bin/node" }],
        allowlistSatisfied: true,
        segments,
        segmentAllowlistEntries: [{ pattern: "/usr/bin/node", source: "allow-always" }],
        segmentSatisfiedBy: ["allowlist"],
        authorizationPlan,
      });
      enforcedCommandMock.mockReturnValue({ ok: true, command: enforcedCommand });
      const approvedCwd = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-cwd-approved-")),
      );
      const movedCwd = `${approvedCwd}-moved`;
      try {
        const result = await runGatewayAllowlist({ command, workdir: approvedCwd });
        expect(result.deniedResult).toBeUndefined();
        expect(result.revalidateBeforeExecution).toBeTypeOf("function");

        fs.renameSync(approvedCwd, movedCwd);
        fs.mkdirSync(approvedCwd);

        const denied = await result.revalidateBeforeExecution?.();
        expect(denied?.content[0]).toMatchObject({
          text: expect.stringContaining("SYSTEM_RUN_DENIED: approval cwd changed before execution"),
        });
      } finally {
        fs.rmSync(approvedCwd, { recursive: true, force: true });
        fs.rmSync(movedCwd, { recursive: true, force: true });
      }
    },
  );

  it("emits a denied security event for inline unavailable approval denials", async () => {
    approvalRouteFixture.inline = true;
    const captured = captureSecurityEvents();

    try {
      await expect(
        runGatewayAllowlist({
          command: "deploy --token raw-secret-value",
          agentId: "agent-1",
        }),
      ).rejects.toThrow("denied");
    } finally {
      captured.stop();
    }

    expect(captured.events.map(({ action, outcome, reason }) => [action, outcome, reason])).toEqual(
      [
        ["exec.approval.requested", "success", undefined],
        ["exec.approval.denied", "denied", "approval-timeout"],
      ],
    );
    const serialized = JSON.stringify(captured.events);
    expect(serialized).not.toContain("deploy");
    expect(serialized).not.toContain("raw-secret-value");
    expect(serialized).not.toContain("agent-1");
  });

  it.runIf(process.platform !== "win32")(
    "reviews an unquoted glob and semicolon chain and pins its dispatches once",
    async () => {
      const command = "ls *.ts; echo complete";
      await configurePlanBackedCommand({ command });
      reviewerMock.mockResolvedValue({
        decision: "allow-once",
        risk: "medium",
        rationale: "project inspection",
      });
      const warnings: string[] = [];
      const result = await runGatewayAllowlist({ command, autoReview: true, warnings });

      expectCall(reviewerMock, {
        command,
        reason: "execution-plan-miss",
        argv: undefined,
        resolvedPath: undefined,
        analysis: expect.objectContaining({ parsed: true, heredoc: false }),
      });
      expect(result.execCommandOverride).toMatch(
        /^'\/[^']*\/ls' \*\.ts; '\/[^']*\/echo' complete$/,
      );
      expect(result.allowWithoutEnforcedCommand).toBeUndefined();
      await expect(result.revalidateBeforeExecution?.()).resolves.toBeUndefined();
      expect(approvalRouteMock).not.toHaveBeenCalled();
      expectAuthorization({ source: "auto-review" });
      expect(warnings).toContain("Exec auto-review allowed once (risk=medium): project inspection");
    },
  );

  it("escalates the third session denial and resets after reviewer allowance or human resolution", async () => {
    const command = "echo review";
    await configurePlanBackedCommand({ command });
    reviewerMock.mockResolvedValue({
      decision: "deny",
      risk: "medium",
      rationale: "narrow it",
    });
    const sessionKey = "agent:main:auto-denial-circuit";
    const run = (warnings: string[] = []) =>
      runGatewayAllowlist({ command, autoReview: true, sessionKey, warnings });
    const expectDenied = async () =>
      expect((await run()).deniedResult?.details).toMatchObject({
        failureKind: "auto-review-denied",
      });
    await expectDenied();
    await expectDenied();
    reviewerMock.mockResolvedValueOnce({
      decision: "allow-once",
      risk: "medium",
      rationale: "safe now",
    });
    expect((await run()).deniedResult).toBeUndefined();
    await expectDenied();
    await expectDenied();
    expect(approvalRouteMock).not.toHaveBeenCalled();
    // Human denial resolves the escalation and starts a new denial sequence.
    approvalDecisionMock.mockResolvedValueOnce("deny");
    const warnings: string[] = [];
    await run(warnings);
    expect(approvalRouteMock).toHaveBeenCalledTimes(1);
    expect(warnings).toContain(
      "Exec auto-review denied 3 consecutive commands for this session; escalating to human approval",
    );
    await expectDenied();
    await expectDenied();
    expect(approvalRouteMock).toHaveBeenCalledTimes(1);
    const otherSession = await runGatewayAllowlist({
      command,
      autoReview: true,
      sessionKey: "agent:main:independent-circuit",
    });
    expect(otherSession.deniedResult?.details).toMatchObject({ failureKind: "auto-review-denied" });
    await run();
    expect(approvalRouteMock).toHaveBeenCalledTimes(2);
  });

  it("returns approval-required when non-interactive auto-review asks for a human", async () => {
    const command = "echo review";
    await configurePlanBackedCommand({ command });
    reviewerMock.mockResolvedValue({
      decision: "ask",
      risk: "low",
      rationale: "reviewed",
    });
    const result = await runGatewayAllowlist({
      command,
      autoReview: true,
      nonInteractiveApproval: true,
    });
    expect(reviewerMock).toHaveBeenCalledOnce();
    expect(approvalRouteMock).not.toHaveBeenCalled();
    expect(result.deniedResult?.details).toMatchObject({
      status: "failed",
      failureKind: "approval_required",
    });
    expect(commitAuthorizationMock).not.toHaveBeenCalled();
  });

  it("keeps always-ask commands on the human approval path", async () => {
    const command = "echo review";
    await configurePlanBackedCommand({ command, hostAsk: "always" });
    await runGatewayAllowlist({ command, autoReview: true });
    expect(reviewerMock).not.toHaveBeenCalled();
    expect(approvalRouteMock).toHaveBeenCalledOnce();
  });

  it("publishes and records the approved Guardian review on its exec call", async () => {
    const assessment = { decision: "allow-once", risk: "low", rationale: "read-only" } as const;
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    const review = createDeferredCore<Awaited<ReturnType<ExecAutoReviewer>>>();
    const autoReviewer = vi.fn<ExecAutoReviewer>(() => review.promise);
    const reviews: Array<Record<string, unknown>> = [];
    const publicationOrder: string[] = [];
    const onApprovalReview = vi.fn((value: { status: string }) => {
      publicationOrder.push(`stored:${value.status}`);
    });
    const unsubscribe = onAgentEvent((event) => {
      if (
        event.runId === "run-review" &&
        event.stream === "tool" &&
        event.data.phase === "review"
      ) {
        publicationOrder.push(`emitted:${String(event.data.approvalReviewOutcome)}`);
        reviews.push(event.data);
      }
    });
    try {
      const pending = runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        runId: "run-review",
        toolCallId: "tool-review",
        onApprovalReview,
      });
      await vi.waitFor(() => expect(autoReviewer).toHaveBeenCalledOnce());
      expect(reviews).toMatchObject([
        {
          toolCallId: "tool-review",
          approvalReviewOutcome: "reviewing",
          review: { status: "in_progress" },
        },
      ]);
      review.resolve(assessment);
      const result = await pending;
      expect(reviews.map((event) => event.approvalReviewOutcome)).toEqual([
        "reviewing",
        "approved",
      ]);
      expect(reviews[1]).toMatchObject({
        toolCallId: "tool-review",
        review: {
          id: "guardian:tool-review",
          status: "approved",
          riskLevel: assessment.risk,
          rationale: assessment.rationale,
        },
      });
      expect(publicationOrder).toEqual([
        "emitted:reviewing",
        "stored:approved",
        "emitted:approved",
      ]);
      expect(approvalRouteMock).not.toHaveBeenCalled();
      expect(result.deniedResult).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it.runIf(process.platform !== "win32")(
    "keeps login-shell startup commands on human approval",
    async () => {
      const command = "/bin/sh -lc 'printf ok'";
      await configurePlanBackedCommand({ command });
      const warnings: string[] = [];
      await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true, warnings });
      expect(reviewerMock).not.toHaveBeenCalled();
      expect(approvalRouteMock).toHaveBeenCalledOnce();
      expect(approvalRouteMock).toHaveBeenCalledWith(
        expect.objectContaining({ requiresAutoReviewHumanApproval: true }),
      );
      expect(warnings).toContain(
        "Exec auto-review skipped: login or interactive shell startup requires human approval",
      );
    },
  );

  it("does not execute after cancellation wins during auto-review", async () => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    const autoReviewer = vi.fn<ExecAutoReviewer>(() => new Promise(() => {}));
    const abortController = new AbortController();
    const reviewStatuses: string[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (
        event.runId === "run-cancelled-review" &&
        event.stream === "tool" &&
        event.data.phase === "review"
      ) {
        const review = event.data.review as { status?: unknown } | undefined;
        if (typeof review?.status === "string") {
          reviewStatuses.push(review.status);
        }
      }
    });

    try {
      const result = runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        signal: abortController.signal,
        runId: "run-cancelled-review",
        toolCallId: "tool-cancelled-review",
      });
      await vi.waitFor(() => expect(autoReviewer).toHaveBeenCalledTimes(1));

      abortController.abort(new Error("cancelled during review"));

      await expect(result).rejects.toThrow("cancelled during review");
    } finally {
      unsubscribe();
    }
    expect(reviewStatuses).toEqual(["in_progress", "aborted"]);
    expect(approvalRouteMock).not.toHaveBeenCalled();
  });

  it("rejects contradictory high-risk custom reviewer approvals", async () => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    reviewerMock.mockResolvedValueOnce({
      decision: "allow-once",
      risk: "high",
      rationale: "contradictory custom decision",
    } as never);

    const result = await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true });

    expect(approvalRouteMock).toHaveBeenCalledTimes(1);
    expect(result.deniedResult?.details.status).toBe("failed");
  });

  it("auto-reviews strict inline-eval commands instead of forcing human approval", async () => {
    const command = "python3 -c 'print(1)'";
    const { invocationPath } = await configurePlanBackedCommand({
      command,
      allowlistSatisfied: true,
      requiresApproval: false,
      satisfiedBy: "allowlist",
    });
    inlineEvalMock.mockReturnValue(INLINE_EVAL_HIT);
    const warnings: string[] = [];

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      autoReview: true,
      strictInlineEval: true,
      warnings,
    });

    expectCall(reviewerMock, {
      command,
      argv: ["python3", "-c", "print(1)"],
      host: "gateway",
      reason: "strict-inline-eval",
      analysis: expect.objectContaining({ inlineEval: true }),
    });
    expect(approvalRouteMock).not.toHaveBeenCalled();
    expect(warnings[0]).toContain("reviewer or explicit approval");
    expect(result.execCommandOverride).toBe(`'${invocationPath}' -c 'print(1)'`);
  });

  it("does not bind current policy to redundant exact-command trust", async () => {
    const command = "cd .";
    const { authorizationPlan } = await configurePlanBackedCommand({
      command,
      env: { PATH: "/usr/bin:/bin" },
      allowlistSatisfied: true,
      requiresApproval: false,
      segmentAllowlistEntries: [null],
      satisfiedBy: "safeBuiltins",
    });
    const enforced = buildAuthorizedShellCommandFromPlan({
      plan: authorizationPlan,
      mode: "enforced",
      segmentSatisfiedBy: ["safeBuiltins"],
    });
    if (!enforced.ok) {
      throw new Error(enforced.reason);
    }
    mockExactTrust(command);

    const result = await runGatewayAllowlist({ command });

    expect(approvalRouteMock).not.toHaveBeenCalled();
    expect(result.execCommandOverride).toBe(enforced.command);
    expectAuthorization({
      source: "current-policy",
      requireExactCommandApproval: false,
      requireDurableAllowlistApproval: false,
    });
  });

  it("omits allow-always when allowlist execution cannot persist reusable patterns", async () => {
    const command = "ls *.ts";
    await configurePlanBackedCommand({
      command,
      env: { PATH: "/usr/bin:/bin" },
      allowlistSatisfied: true,
      requiresApproval: false,
      segmentAllowlistEntries: [{ pattern: "/usr/bin/ls", source: "allow-always" }],
      satisfiedBy: "allowlist",
    });
    durableApprovalMock.mockReturnValue(false);

    const result = await runGatewayAllowlist({
      approvalFollowupMode: "agent",
      command,
      ask: "on-miss",
      autoReview: false,
    });

    expectPending(result);
    expectCall(pendingResultMock, {
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("binds mixed allowlist authorization to exact trust when it bypasses an unavailable plan", async () => {
    const command = "ls *.ts";
    const allowlistEntry: ExecAllowlistEntry = {
      pattern: "/usr/bin/ls",
      source: "allow-always",
    };
    await configurePlanBackedCommand({
      command,
      env: { PATH: "/usr/bin:/bin" },
      requiresApproval: false,
      allowlistMatches: [allowlistEntry],
      allowlistSatisfied: true,
      segmentAllowlistEntries: [allowlistEntry],
      satisfiedBy: "allowlist",
    });
    mockExactTrust(command, [allowlistEntry]);
    commitAuthorizationMock.mockRejectedValueOnce(new Error("exact-command approval revoked"));

    await expect(
      runGatewayAllowlist({
        command,
        ask: "off",
        autoReview: false,
      }),
    ).rejects.toThrow("exact-command approval revoked");

    expect(approvalRouteMock).not.toHaveBeenCalled();
    expectAuthorization({
      source: "current-policy",
      requireExactCommandApproval: true,
      requireDurableAllowlistApproval: false,
    });
  });

  it("offers allow-always for shell-wrapper misses with reusable executable patterns", async () => {
    if (process.platform === "win32") {
      return;
    }

    const command = "sh -c 'git status'";
    const env = { PATH: "/usr/bin:/bin" };
    const secretEgressBindings = [
      {
        name: "SERVICE_KEY",
        sentinel: "synthetic-approval-sentinel",
        allowedHosts: ["api.example.com"],
      },
    ];
    await configurePlanBackedCommand({ command, env });
    const approval = createDeferredCore<"allow-always">();
    approvalDecisionMock.mockReturnValue(approval.promise);
    mockCompletedProcess();

    const result = await runGatewayAllowlist({
      approvalFollowupMode: "agent",
      command,
      ask: "on-miss",
      env,
      secretEgressBindings,
      autoReview: false,
    });
    const expectedGitArgPattern = buildCwdBoundHashedArgPattern(
      ["/usr/bin/git", "status"],
      process.cwd(),
    );

    expectPending(result);
    expectCall(pendingResultMock, {
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    expect(runExecProcessMock).not.toHaveBeenCalled();
    approval.resolve("allow-always");
    await waitForFollowup();
    expect(runExecProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ env, secretEgressBindings }),
    );
    expectCall(commitAuthorizationMock, {
      authorization: expect.objectContaining({ source: "explicit-approval" }),
      allowAlwaysDecision: {
        kind: "patterns",
        commandText: "sh -c 'git status'",
        patterns: [{ pattern: "/usr/bin/git", argPattern: expectedGitArgPattern }],
      },
    });
  });

  it.runIf(process.platform !== "win32")(
    "defers compound plans with more than 64 candidates before Guardian review",
    async () => {
      const command = Array.from({ length: 65 }, () => "/bin/echo ok").join(" && ");
      await configurePlanBackedCommand({ command });

      const result = await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true });

      expect(reviewerMock).not.toHaveBeenCalled();
      expect(approvalRouteMock).toHaveBeenCalledOnce();
      expect(result.deniedResult?.details.status).toBe("failed");
    },
  );

  it("does not use fallback-full when auto-review asks for human approval", async () => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    mockHostPolicy({ hostSecurity: "full", hostAsk: "on-miss", askFallback: "full" });
    reviewerMock.mockResolvedValue({
      decision: "ask",
      risk: "medium",
      rationale: "needs a person",
    });
    approvalDecisionMock.mockResolvedValue(null);
    const result = await runGatewayAllowlist({
      command,
      security: "full",
      ask: "on-miss",
      autoReview: true,
      turnSourceChannel: "webchat",
    });
    expect(reviewerMock).toHaveBeenCalledOnce();
    expect(result.deniedResult?.details.status).toBe("failed");
    expect(result.deniedResult?.content[0]).toMatchObject({
      text: `Exec denied (gateway id=${approvalRouteFixture.id}, approval-timeout): echo ok\nCommand did not run: approval timed out.`,
    });
  });

  it("allows durable exact-command trust to bypass the synchronous allowlist miss", async () => {
    const command = "/bin/echo durable";
    mockAllowlist({
      analysisOk: false,
      segments: [{ resolution: null, argv: ["/bin/echo", "durable"] }],
      segmentSatisfiedBy: [],
    });
    durableApprovalMock.mockReturnValue(true);
    exactApprovalMock.mockReturnValue(true);
    enforcedCommandMock.mockReturnValue({
      ok: true,
      command,
    });
    mockExactTrust(command);

    const result = await runGatewayAllowlist({ command });

    expect(approvalRouteMock).not.toHaveBeenCalled();
    expect(result.execCommandOverride).toBeUndefined();
    expectAuthorization({
      source: "current-policy",
      requireExactCommandApproval: true,
    });
  });

  it("keeps denying allowlist misses when durable trust does not match", async () => {
    mockAllowlist({
      analysisOk: false,
      segments: [{ resolution: null, argv: ["node", "--version"] }],
    });
    durableApprovalMock.mockReturnValue(false);

    await expect(
      runGatewayAllowlist({
        command: "node --version",
      }),
    ).rejects.toThrow("exec denied: allowlist miss");
  });

  it("keeps webchat diagnostics approvals as direct pasteable followups", async () => {
    mockApprovedDetachedExec({
      outcome: completedOutcome(
        JSON.stringify({
          path: "/tmp/openclaw-diagnostics.zip",
          bytes: 1234,
          manifest: {
            generatedAt: "2026-04-28T20:58:29.311Z",
            openclawVersion: "2026.4.27",
            contents: [
              { path: "diagnostics.json", bytes: 100 },
              { path: "summary.md", bytes: 200 },
            ],
            privacy: {
              payloadFree: true,
              rawLogsIncluded: false,
              notes: ["Logs keep operational summaries."],
            },
          },
        }),
      ),
    });

    const approvalFollowup = vi.fn<ExecApprovalFollowupFactory>(
      async () => "Synthetic harness diagnostics: thread-1",
    );

    const result = await runGatewayAllowlist({
      command: "openclaw gateway diagnostics export --json",
      trigger: "diagnostics",
      approvalFollowupMode: "direct",
      approvalFollowup,
      turnSourceChannel: "webchat",
    });
    expectPending(result);
    await waitForFollowup();

    const followupTarget = followupMock.mock.calls[0]?.[0];
    expect(followupTarget?.direct).toBe(true);
    const followupText = requireSentFollowupText();
    expect(followupText).toContain("Diagnostics export created.");
    expect(followupText).toContain("Path: /tmp/openclaw-diagnostics.zip");
    expect(followupText).toContain("Contents (2 files):");
    expect(followupText).toContain("Size: 1234 bytes");
    expect(followupText).toContain("Privacy:\n- payload-free: yes\n- raw logs included: no");
    expect(followupText).toContain("- Logs keep operational summaries.");
    expect(followupText).toContain("Synthetic harness diagnostics: thread-1");
    expect(approvalFollowup.mock.calls[0]?.[0]).toMatchObject({
      approvalId: approvalRouteFixture.id,
      sessionId: "sess-1",
      trigger: "diagnostics",
      outcome: { status: "completed", exitCode: 0 },
    });
  });

  it("keeps a completed detached outcome terminal when agent follow-up registration fails", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();
    const outcome = completedOutcome("completed output");
    const approvalFollowup = vi.fn<ExecApprovalFollowupFactory>(() => undefined);
    mockApprovedDetachedExec({ outcome });
    followupMock.mockRejectedValueOnce(
      new Error("synchronous runtime-handoff registration failure"),
    );

    try {
      await runDetached({
        command: "side-effecting-command",
        approvalFollowup,
      });
      await vi.waitFor(() => expect(approvalFollowup).toHaveBeenCalledOnce());
      await setImmediate();

      expect(approvalFollowup.mock.calls[0]?.[0].outcome).toEqual(outcome);
      expect(unhandledRejections.reasons).toEqual([]);
      expect(followupMock).toHaveBeenCalledOnce();
      expect(requireSentFollowupText()).toContain("completed output");
      expect(requireSentFollowupText()).not.toContain("Exec denied");
    } finally {
      unhandledRejections.restore();
    }
  });

  it("consumes rejected detached request-failure and fallback follow-ups", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();
    approvalDecisionMock.mockRejectedValueOnce(new Error("approval request failed"));
    followupMock.mockRejectedValue(new Error("denial follow-up failed"));
    try {
      await runDetached({
        command: "side-effecting-command",
      });
      await vi.waitFor(() => expect(followupMock).toHaveBeenCalledTimes(2));
      await setImmediate();
      expect(unhandledRejections.reasons).toEqual([]);
      const denied = `Exec denied (gateway id=${approvalRouteFixture.id}, approval-request-failed): side-effecting-command`;
      expect(requireSentFollowupText()).toBe(denied);
      expect(requireSentFollowupText(1)).toBe(denied);
      expect(runExecProcessMock).not.toHaveBeenCalled();
    } finally {
      unhandledRejections.restore();
    }
  });

  it("fails closed when a detached allow-always authorization commit fails", async () => {
    approvalDecisionMock.mockResolvedValue("allow-always");
    commitAuthorizationMock.mockRejectedValueOnce(new Error("approval lock unavailable"));
    const captured = captureSecurityEvents();
    try {
      const result = await runGatewayAllowlist({
        approvalFollowupMode: "agent",
        command: "echo approved",
      });
      expectPending(result);
      await waitForFollowup();
      expect(requireSentFollowupText()).toContain("approval-state-write-failed");
      expect(runExecProcessMock).not.toHaveBeenCalled();
      expect(commitAuthorizationMock).toHaveBeenCalledOnce();
      expectCall(commitAuthorizationMock, {
        authorization: expect.objectContaining({ source: "explicit-approval" }),
        allowAlwaysDecision: expect.any(Object),
      });
      expect(captured.events.at(-1)).toMatchObject({
        action: "exec.approval.denied",
        outcome: "error",
        policy: { reason: "approval-state-write-failed" },
      });
    } finally {
      captured.stop();
    }
  });

  it("emits inline approval park and clear events for a denial", async () => {
    approvalDecisionMock.mockResolvedValue("deny");
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === "run-inline" && event.stream === "lifecycle") {
        events.push(event.data);
      }
    });

    try {
      await runGatewayAllowlist({
        command: "pwd",
        turnSourceChannel: "webchat",
        runId: "run-inline",
        toolCallId: "tool-inline",
        sessionKey: "agent:main:main",
        sessionId: "session-inline",
      });
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([
      { phase: "waiting-approval", approvalId: approvalRouteFixture.id, toolCallId: "tool-inline" },
      {
        phase: "approval-resolved",
        approvalId: approvalRouteFixture.id,
        toolCallId: "tool-inline",
      },
    ]);
  });

  it("waits outside admission, then atomically hands an approved process to the registry", async () => {
    const approval = createDeferredCore<ExecApprovalDecision>();
    const outcome = createDeferredCore<ExecApprovalFollowupOutcome>();
    const spawnAllowed = createDeferredCore();
    const spawnStarted = createDeferredCore();
    approvalDecisionMock.mockReturnValue(approval.promise);
    commitAuthorizationMock.mockImplementation(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      return () => {};
    });
    runExecProcessMock.mockImplementation(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      spawnStarted.resolve();
      await spawnAllowed.promise;
      return { session: { id: "sess-atomic" }, promise: outcome.promise };
    });
    markBackgroundedMock.mockImplementation(() => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    });

    await runDetached();
    await vi.waitFor(() => expect(approvalDecisionMock).toHaveBeenCalledOnce());
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    approval.resolve("allow-once");
    await Promise.resolve();
    await Promise.resolve();
    expectNoCalls(commitAuthorizationMock, runExecProcessMock, markBackgroundedMock);

    suspension?.release();
    await spawnStarted.promise;
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    spawnAllowed.resolve();
    await vi.waitFor(() => {
      expect(markBackgroundedMock).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    expect(commitAuthorizationMock).toHaveBeenCalledOnce();
    expect(runExecProcessMock).toHaveBeenCalledOnce();

    outcome.resolve(completedOutcome());
    await waitForFollowup();
  });

  it("re-prompts durable detached gateway script approvals and rejects changed bytes", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-script-binding-"));
    const script = path.join(workdir, "script.sh");
    const command = "sh script.sh";
    try {
      fs.writeFileSync(script, "#!/bin/sh\necho approved\n");
      mockAllowlist({
        segments: [{ resolution: null, argv: ["sh", "script.sh"] }],
        segmentSatisfiedBy: [],
      });
      mockExactTrust(command);
      approvalDecisionMock.mockImplementation(async () => {
        fs.writeFileSync(script, "#!/bin/sh\necho mutated\n");
        return "allow-once";
      });
      mockCompletedProcess("approved", "sess-script-binding");

      await runDetached({
        command,
        workdir,
      });
      expect(pendingResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ allowedDecisions: ["allow-once", "deny"] }),
      );
      await waitForFollowup();
      expect(requireSentFollowupText()).toContain(
        "approval script operand changed before execution",
      );
      expectNoCalls(commitAuthorizationMock, runExecProcessMock);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("denies a detached approved process when restart drain wins admission", async () => {
    const approval = createDeferredCore<ExecApprovalDecision>();
    approvalDecisionMock.mockReturnValue(approval.promise);

    await runDetached();
    await vi.waitFor(() => expect(approvalDecisionMock).toHaveBeenCalledOnce());

    markGatewayRestartDraining();
    approval.resolve("allow-once");
    await vi.waitFor(() => {
      expect(followupMock).toHaveBeenCalledWith(
        expect.anything(),
        `Exec denied (gateway id=${approvalRouteFixture.id}, gateway-draining): find . -maxdepth 1`,
      );
    });
    expect(followupMock).toHaveBeenCalledOnce();
    expectNoCalls(commitAuthorizationMock, runExecProcessMock, markBackgroundedMock);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "resolves a rotated GitHub credential only after delayed approval",
    async () => {
      const followupDelivered = createDeferredCore();
      followupMock.mockImplementation(async () => {
        followupDelivered.resolve();
      });
      const runtime = await vi.importActual<typeof import("./bash-tools.exec-runtime.js")>(
        "./bash-tools.exec-runtime.js",
      );
      runExecProcessMock.mockImplementation(runtime.runExecProcess);
      const profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delayed-github-")));
      const hostsPath = path.join(profileDir, "hosts.yml");
      fs.writeFileSync(hostsPath, "github.com:\n  oauth_token: synthetic-before-approval\n", {
        mode: 0o600,
      });
      let releaseApproval: () => void = () => {};
      approvalDecisionMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseApproval = () => resolve("allow-once");
          }),
      );
      const supervisor = createProcessSupervisor();
      startupCancellationMocks.spawn.mockImplementation(supervisor.spawn.bind(supervisor));
      const fixturePath = path.join(profileDir, "auth-result.cjs");
      fs.writeFileSync(
        fixturePath,
        `
        process.stdout.write(process.env.GH_TOKEN === "synthetic-after-approval"
          ? "selected-after-approval" : "wrong-account");
      `,
      );
      const command = [process.execPath, fixturePath].map(quoteCliArg).join(" ");
      const env = Object.freeze({
        PATH: "/usr/bin:/bin",
        GH_CONFIG_DIR: profileDir,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
      });
      try {
        await runDetached({
          command,
          env,
          requestedEnv: env,
          githubProfileDir: profileDir,
        });
        await vi.waitFor(() => expect(approvalDecisionMock).toHaveBeenCalledOnce());
        expect(startupCancellationMocks.spawn).not.toHaveBeenCalled();
        fs.writeFileSync(hostsPath, "github.com:\n  oauth_token: synthetic-after-approval\n");
        releaseApproval();
        await followupDelivered.promise;
        expect(followupMock.mock.calls.length).toBe(1);
        expect(requireSentFollowupText()).toContain("selected-after-approval");
        expect(startupCancellationMocks.spawn).toHaveBeenCalledOnce();
        expect(env.GH_TOKEN).toBe("");
        expect(JSON.stringify(approvalRouteMock.mock.calls)).not.toContain(
          "synthetic-after-approval",
        );
        expect(JSON.stringify(followupMock.mock.calls)).not.toContain("synthetic-after-approval");
        expect(JSON.stringify(startupCancellationMocks.spawn.mock.calls)).not.toContain(
          "synthetic-after-approval",
        );
      } finally {
        releaseApproval();
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        await supervisor.shutdown();
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    },
  );

  it("does not spawn or send a detached followup after cancellation during startup", async () => {
    const controller = new AbortController();
    mockApprovedDetachedExec({ outcome: completedOutcome() });
    const runtime = await vi.importActual<typeof import("./bash-tools.exec-runtime.js")>(
      "./bash-tools.exec-runtime.js",
    );
    runExecProcessMock.mockImplementation(runtime.runExecProcess);
    startupCancellationMocks.prepare.mockImplementationOnce(() =>
      controller.abort(new Error("cancelled while preparing")),
    );

    await runDetached({
      signal: controller.signal,
      env: { PATH: "/usr/bin:/bin" },
    });
    await vi.waitFor(() => expect(startupCancellationMocks.prepare).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(startupCancellationMocks.spawn.mock.calls.length).toBe(0);
    expectNoCalls(markBackgroundedMock, followupMock);
  });

  it("drops detached execution and follow-up when the owning run is aborted", async () => {
    approvalDecisionMock.mockRejectedValue(runAbortedApprovalError);

    await runDetached({
      runId: "run-aborted",
      toolCallId: "tool-aborted",
    });
    await vi.waitFor(() => expect(approvalDecisionMock).toHaveBeenCalledOnce());
    expectNoCalls(commitAuthorizationMock, runExecProcessMock, followupMock);
  });

  it.each([false, true])(
    "binds a full-policy timeout to the allowlist plan (headless=%s)",
    async (headless) => {
      const { command, enforcedCommand } = await mockAllowlistTimeoutFallback("full");
      approvalRouteFixture.inline = headless;
      if (!headless) {
        approvalDecisionMock.mockResolvedValue(null);
      }
      const result = await runGatewayAllowlist({
        command,
        security: "full",
        ask: "always",
        ...(headless ? { trigger: "cron" } : { turnSourceChannel: "webchat" }),
      });

      expect(result.execCommandOverride).toBe(enforcedCommand);
      expectAuthorization({
        source: "ask-fallback",
        security: "allowlist",
        allowlistSatisfied: true,
      });
    },
  );

  it("denies allowlist timeout fallback without an enforceable plan", async () => {
    requiresApprovalMock.mockReturnValue(true);
    mockAllowlist({
      allowlistMatches: [{ pattern: "/usr/bin/rg" }],
      allowlistSatisfied: true,
      segments: [{ resolution: null, argv: ["rg", "needle"] }],
      segmentAllowlistEntries: [{ pattern: "/usr/bin/rg" }],
      segmentSatisfiedBy: ["allowlist"],
    });
    mockHostPolicy({ hostSecurity: "full", hostAsk: "always", askFallback: "allowlist" });
    approvalDecisionMock.mockResolvedValue(null);

    const result = await runGatewayAllowlist({
      command: "rg needle",
      security: "full",
      ask: "always",
      turnSourceChannel: "webchat",
    });

    expect(result.deniedResult?.content[0]).toMatchObject({
      text: expect.stringContaining("approval-timeout: execution-plan-miss"),
    });
    expect(commitAuthorizationMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
