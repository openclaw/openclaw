/**
 * Gateway-host exec approval tests.
 * Covers allowlist misses, auto-review, strict inline eval, diagnostics
 * follow-ups, and gateway approval result routing.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { buildCronExecOperationBinding } from "../gateway/operator-approval-standing-grants.js";
import {
  insertOperatorApproval,
  resolveOperatorApproval,
} from "../gateway/operator-approval-store.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { registerCronRunExecSource } from "../infra/cron-run-exec-source.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticSecurityEvent,
} from "../infra/diagnostic-events.js";
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
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import type {
  ExecApprovalFollowupFactory,
  ExecApprovalFollowupOutcome,
} from "./bash-tools.exec-types.js";

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

const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const buildExecApprovalFollowupTargetMock = vi.hoisted(() =>
  vi.fn<typeof import("./bash-tools.exec-host-shared.js").buildExecApprovalFollowupTarget>(),
);
const evaluateShellAllowlistWithAuthorizationMock = vi.hoisted(() =>
  vi.fn<() => MockAllowlistResult>(),
);
const hasDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const hasExactCommandDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => false));
const requiresExecApprovalMock = vi.hoisted(() => vi.fn(() => false));
const buildEnforcedShellCommandMock = vi.hoisted(() =>
  vi.fn<() => { ok: boolean; reason?: string; command?: string }>(),
);
const defaultExecAutoReviewerMock = vi.hoisted(() => vi.fn<ExecAutoReviewer>());
const commitExecAuthorizationMock = vi.hoisted(() =>
  vi.fn<typeof import("../infra/exec-approvals.js").commitExecAuthorizationLocked>(
    async () => () => {},
  ),
);
const approvalDecisionMock = vi.hoisted(() =>
  vi.fn<() => Promise<string | null | undefined>>(async () => undefined),
);
const runAbortedApprovalError = vi.hoisted(() => new Error("run aborted"));
const approvalRouteFixture = vi.hoisted(() => ({ inline: false, id: "" }));
const callGatewayToolMock = vi.hoisted(() =>
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
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn<() => MockExecHostApprovalContext>(),
);
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
const sendExecApprovalFollowupResultMock = vi.hoisted(() =>
  vi.fn<SendExecApprovalFollowupResult>(async () => undefined),
);
const createExecApprovalRequestRouteMock = vi.hoisted(() =>
  vi.fn<typeof import("./bash-tools.exec-host-shared.js").createExecApprovalRequestRoute>(),
);
const detectInterpreterInlineEvalArgvMock = vi.hoisted(() =>
  vi.fn<() => typeof INLINE_EVAL_HIT | null>(),
);

vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  evaluateShellAllowlistWithAuthorization: evaluateShellAllowlistWithAuthorizationMock,
  hasDurableExecApproval: hasDurableExecApprovalMock,
  hasExactCommandDurableExecApproval: hasExactCommandDurableExecApprovalMock,
  buildEnforcedShellCommand: buildEnforcedShellCommandMock,
  requiresExecApproval: requiresExecApprovalMock,
  commitExecAuthorizationLocked: commitExecAuthorizationMock,
  resolveApprovalAuditTrustPath: vi.fn(() => null),
  resolveAllowAlwaysPatterns: vi.fn(() => []),
}));

vi.mock("../infra/exec-auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-auto-review.js")>()),
  defaultExecAutoReviewer: defaultExecAutoReviewerMock,
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("./bash-tools.exec-host-shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bash-tools.exec-host-shared.js")>();
  createExecApprovalRequestRouteMock.mockImplementation(actual.createExecApprovalRequestRoute);
  buildExecApprovalFollowupTargetMock.mockImplementation(actual.buildExecApprovalFollowupTarget);
  return {
    ...actual,
    resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
    buildExecApprovalFollowupTarget: buildExecApprovalFollowupTargetMock,
    buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
    createExecApprovalRequestRoute: createExecApprovalRequestRouteMock,
    sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  };
});

vi.mock("./bash-tools.exec-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-runtime.js")>()),
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
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

let processGatewayAllowlist: typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist;
type GatewayAllowlistParams = Parameters<typeof processGatewayAllowlist>[0];

function requireSentFollowupText(callIndex = 0): string {
  return sendExecApprovalFollowupResultMock.mock.calls[callIndex]?.[1] ?? "";
}

function captureProcessUnhandledRejections() {
  const reasons: unknown[] = [];
  const originalProcessEmit = process.emit.bind(process);
  const processEmit = vi.spyOn(process, "emit").mockImplementation((event, ...args) => {
    if (event === "unhandledRejection") {
      reasons.push(args[0]);
      return true;
    }
    return originalProcessEmit(event, ...args);
  });
  return { reasons, restore: () => processEmit.mockRestore() };
}

function captureSecurityEvents(): {
  events: DiagnosticSecurityEvent[];
  stop: () => void;
} {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

describe("processGatewayAllowlist", () => {
  beforeAll(async () => {
    ({ processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js"));
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetDiagnosticEventsForTest();
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockClear();
    evaluateShellAllowlistWithAuthorizationMock.mockReset();
    mockAllowlist({
      allowlistSatisfied: true,
      segments: [{ resolution: null, argv: ["echo", "ok"] }],
      segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
      segmentSatisfiedBy: [],
    });
    hasDurableExecApprovalMock.mockReset();
    hasDurableExecApprovalMock.mockReturnValue(true);
    hasExactCommandDurableExecApprovalMock.mockReset();
    hasExactCommandDurableExecApprovalMock.mockReturnValue(false);
    requiresExecApprovalMock.mockReset();
    requiresExecApprovalMock.mockReturnValue(false);
    buildEnforcedShellCommandMock.mockReset();
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: false,
      reason: "segment execution plan unavailable",
    });
    defaultExecAutoReviewerMock.mockReset();
    defaultExecAutoReviewerMock.mockResolvedValue({
      decision: "allow-once",
      risk: "low",
      rationale: "allowed",
    });
    commitExecAuthorizationMock.mockReset();
    approvalDecisionMock.mockReset();
    approvalDecisionMock.mockResolvedValue(undefined);
    approvalRouteFixture.inline = false;
    callGatewayToolMock.mockClear();
    approvalRouteFixture.id = "";
    resolveExecHostApprovalContextMock.mockReset();
    mockHostPolicy();
    runExecProcessMock.mockReset();
    startupCancellationMocks.spawn.mockReset();
    startupCancellationMocks.prepare.mockReset();
    markBackgroundedMock.mockReset();
    sendExecApprovalFollowupResultMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      details: { status: "approval-pending" },
      content: [],
    });
    createExecApprovalRequestRouteMock.mockClear();
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    resetGatewayWorkAdmission();
  });

  function mockHostPolicy(overrides: Partial<MockExecHostApprovalContext> = {}) {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
      ...overrides,
    });
  }

  function mockAllowlist(overrides: Partial<MockAllowlistResult> = {}) {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
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
    const { command, ...rest } = overrides;
    return processGatewayAllowlist({
      command,
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
      ...rest,
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
      promise: Promise.resolve({ status: "completed", exitCode: 0, timedOut: false, aggregated }),
    });
  }

  function mockExactTrust(command: string, entries: ExecAllowlistEntry[] = []) {
    hasDurableExecApprovalMock.mockReturnValue(true);
    hasExactCommandDurableExecApprovalMock.mockReturnValue(true);
    mockHostPolicy({
      approvals: {
        allowlist: [...entries, { pattern: exactCommandMarker(command), source: "allow-always" }],
        file: { version: 1, agents: {} },
      },
    });
  }

  async function requireAuthorizationPlan(params: Parameters<typeof planShellAuthorization>[0]) {
    const authorizationPlan = await planShellAuthorization(params);
    expect(authorizationPlan.ok).toBe(true);
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
    expect(enforced.ok).toBe(true);
    if (!enforced.ok) {
      throw new Error(enforced.reason);
    }
    return { command, authorizationPlan, segments, enforcedCommand: enforced.command };
  }

  async function mockAllowlistTimeoutFallback(hostSecurity: ExecSecurity) {
    const { command, authorizationPlan, segments, enforcedCommand } =
      await planAllowlistedNodeVersion();
    const policyPath = resolvePolicyTargetCandidatePath(segments[0]?.resolution ?? null) ?? "node";
    requiresExecApprovalMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReturnValue({ ok: true, command: enforcedCommand });
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
    requiresExecApprovalMock.mockReturnValue(params.requiresApproval ?? true);
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

    expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
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
      buildEnforcedShellCommandMock.mockReturnValue({ ok: true, command: enforcedCommand });
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

  it("emits security events for gateway exec approval requests and denials", async () => {
    approvalDecisionMock.mockResolvedValue("deny");
    const captured = captureSecurityEvents();

    let result: Awaited<ReturnType<typeof runGatewayAllowlist>>;
    try {
      result = await runGatewayAllowlist({
        command: "deploy --token raw-secret-value",
        turnSourceChannel: "webchat",
        agentId: "agent-1",
      });
    } finally {
      captured.stop();
    }

    expect(result!.deniedResult?.details.status).toBe("failed");
    expect(captured.events.map(({ action, outcome, reason }) => [action, outcome, reason])).toEqual(
      [
        ["exec.approval.requested", "success", undefined],
        ["exec.approval.denied", "denied", "user-denied"],
      ],
    );
    const serialized = JSON.stringify(captured.events);
    expect(serialized).not.toContain("deploy");
    expect(serialized).not.toContain("raw-secret-value");
    expect(serialized).not.toContain("agent-1");
  });

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
      defaultExecAutoReviewerMock.mockResolvedValue({
        decision: "allow-once",
        risk: "medium",
        rationale: "project inspection",
      });
      const warnings: string[] = [];
      const result = await runGatewayAllowlist({ command, autoReview: true, warnings });

      expect(defaultExecAutoReviewerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command,
          reason: "execution-plan-miss",
          argv: undefined,
          resolvedPath: undefined,
          analysis: expect.objectContaining({ parsed: true, heredoc: false }),
        }),
      );
      expect(result.execCommandOverride).toMatch(
        /^'\/[^']*\/ls' \*\.ts; '\/[^']*\/echo' complete$/,
      );
      expect(result.allowWithoutEnforcedCommand).toBeUndefined();
      await expect(result.revalidateBeforeExecution?.()).resolves.toBeUndefined();
      expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
      expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          authorization: expect.objectContaining({ source: "auto-review" }),
        }),
      );
      expect(warnings).toContain("Exec auto-review allowed once (risk=medium): project inspection");
    },
  );

  it("escalates the third session denial and resets after reviewer allowance or human resolution", async () => {
    const command = "echo review";
    await configurePlanBackedCommand({ command });
    defaultExecAutoReviewerMock.mockResolvedValue({
      decision: "deny",
      risk: "medium",
      rationale: "narrow it",
    });
    const sessionKey = "agent:main:auto-denial-circuit";
    const run = (warnings: string[] = []) =>
      runGatewayAllowlist({ command, autoReview: true, sessionKey, warnings });
    expect((await run()).deniedResult?.details).toMatchObject({
      failureKind: "auto-review-denied",
    });
    expect((await run()).deniedResult?.details).toMatchObject({
      failureKind: "auto-review-denied",
    });
    defaultExecAutoReviewerMock.mockResolvedValueOnce({
      decision: "allow-once",
      risk: "medium",
      rationale: "safe now",
    });
    expect((await run()).deniedResult).toBeUndefined();
    expect((await run()).deniedResult?.details).toMatchObject({
      failureKind: "auto-review-denied",
    });
    expect((await run()).deniedResult?.details).toMatchObject({
      failureKind: "auto-review-denied",
    });
    expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
    // Human denial resolves the escalation and starts a new denial sequence.
    approvalDecisionMock.mockResolvedValueOnce("deny");
    const warnings: string[] = [];
    await run(warnings);
    expect(createExecApprovalRequestRouteMock).toHaveBeenCalledTimes(1);
    expect(warnings).toContain(
      "Exec auto-review denied 3 consecutive commands for this session; escalating to human approval",
    );
    expect((await run()).deniedResult?.details).toMatchObject({
      failureKind: "auto-review-denied",
    });
    expect((await run()).deniedResult?.details).toMatchObject({
      failureKind: "auto-review-denied",
    });
    expect(createExecApprovalRequestRouteMock).toHaveBeenCalledTimes(1);
    const otherSession = await runGatewayAllowlist({
      command,
      autoReview: true,
      sessionKey: "agent:main:independent-circuit",
    });
    expect(otherSession.deniedResult?.details).toMatchObject({ failureKind: "auto-review-denied" });
    await run();
    expect(createExecApprovalRequestRouteMock).toHaveBeenCalledTimes(2);
  });

  it("returns approval-required when non-interactive auto-review asks for a human", async () => {
    const command = "echo review";
    await configurePlanBackedCommand({ command });
    defaultExecAutoReviewerMock.mockResolvedValue({
      decision: "ask",
      risk: "low",
      rationale: "reviewed",
    });
    const result = await runGatewayAllowlist({
      command,
      autoReview: true,
      nonInteractiveApproval: true,
    });
    expect(defaultExecAutoReviewerMock).toHaveBeenCalledOnce();
    expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
    expect(result.deniedResult?.details).toMatchObject({
      status: "failed",
      failureKind: "approval_required",
    });
    expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
  });

  it("keeps always-ask commands on the human approval path", async () => {
    const command = "echo review";
    await configurePlanBackedCommand({ command, hostAsk: "always" });
    await runGatewayAllowlist({ command, autoReview: true });
    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(createExecApprovalRequestRouteMock).toHaveBeenCalledOnce();
  });

  it.each([
    {
      assessment: { decision: "allow-once", risk: "low", rationale: "read-only" },
      status: "approved",
    },
    {
      assessment: { decision: "ask", risk: "medium", rationale: "needs a person" },
      status: "denied",
    },
  ] as const)(
    "publishes and records the $status Guardian review on its exec call",
    async ({ assessment, status }) => {
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
        const warnings: string[] = [];
        const pending = runGatewayAllowlist({
          command,
          ask: "on-miss",
          autoReview: true,
          autoReviewer,
          runId: "run-review",
          toolCallId: "tool-review",
          onApprovalReview,
          warnings,
        });
        await vi.waitFor(() => expect(autoReviewer).toHaveBeenCalledOnce());
        expect(reviews).toEqual([
          expect.objectContaining({
            toolCallId: "tool-review",
            approvalReviewOutcome: "reviewing",
            review: expect.objectContaining({ label: "Guardian", status: "in_progress" }),
          }),
        ]);
        review.resolve(assessment);
        const result = await pending;
        expect(reviews.map((event) => event.approvalReviewOutcome)).toEqual(["reviewing", status]);
        expect(reviews[1]).toMatchObject({
          toolCallId: "tool-review",
          review: {
            id: "guardian:tool-review",
            label: "Guardian",
            status,
            riskLevel: assessment.risk,
            rationale: assessment.rationale,
          },
        });
        expect(publicationOrder).toEqual([
          "emitted:reviewing",
          `stored:${status}`,
          `emitted:${status}`,
        ]);
        expect(onApprovalReview).toHaveBeenCalledOnce();
        expect(onApprovalReview).toHaveBeenCalledWith(
          expect.objectContaining({ id: "guardian:tool-review", status }),
        );
        if (assessment.decision === "ask") {
          expect(createExecApprovalRequestRouteMock).toHaveBeenCalledOnce();
          expect(warnings.join("\n")).toContain(assessment.rationale);
          expect(result.deniedResult?.details.status).toBe("failed");
        } else {
          expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
          expect(result.deniedResult).toBeUndefined();
        }
      } finally {
        unsubscribe();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps login-shell startup commands on human approval",
    async () => {
      const command = "/bin/sh -lc 'printf ok'";
      await configurePlanBackedCommand({ command });
      const warnings: string[] = [];
      await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true, warnings });
      expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
      expect(createExecApprovalRequestRouteMock).toHaveBeenCalledOnce();
      expect(createExecApprovalRequestRouteMock).toHaveBeenCalledWith(
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
    expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
  });

  it("rejects contradictory high-risk custom reviewer approvals", async () => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    defaultExecAutoReviewerMock.mockResolvedValueOnce({
      decision: "allow-once",
      risk: "high",
      rationale: "contradictory custom decision",
    } as never);

    const result = await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true });

    expect(createExecApprovalRequestRouteMock).toHaveBeenCalledTimes(1);
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
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    const warnings: string[] = [];

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      autoReview: true,
      strictInlineEval: true,
      warnings,
    });

    expect(defaultExecAutoReviewerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command,
        argv: ["python3", "-c", "print(1)"],
        host: "gateway",
        reason: "strict-inline-eval",
        analysis: expect.objectContaining({
          inlineEval: true,
        }),
      }),
    );
    expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
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
    expect(enforced.ok).toBe(true);
    if (!enforced.ok) {
      throw new Error(enforced.reason);
    }
    mockExactTrust(command);

    const result = await runGatewayAllowlist({ command });

    expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      execCommandOverride: enforced.command,
      assertCurrent: expect.any(Function),
      revalidateBeforeExecution: expect.any(Function),
    });
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "current-policy",
          requireExactCommandApproval: false,
          requireDurableAllowlistApproval: false,
        }),
      }),
    );
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
    hasDurableExecApprovalMock.mockReturnValue(false);

    const result = await runGatewayAllowlist({
      approvalFollowupMode: "agent",
      command,
      ask: "on-miss",
      autoReview: false,
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    expect(buildExecApprovalPendingToolResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDecisions: ["allow-once", "deny"],
      }),
    );
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
    commitExecAuthorizationMock.mockRejectedValueOnce(new Error("exact-command approval revoked"));

    await expect(
      runGatewayAllowlist({
        command,
        ask: "off",
        autoReview: false,
      }),
    ).rejects.toThrow("exact-command approval revoked");

    expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "current-policy",
          requireExactCommandApproval: true,
          requireDurableAllowlistApproval: false,
        }),
      }),
    );
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

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    expect(buildExecApprovalPendingToolResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      }),
    );
    expect(runExecProcessMock).not.toHaveBeenCalled();
    approval.resolve("allow-always");
    await vi.waitFor(() => expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce());
    expect(runExecProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ env, secretEgressBindings }),
    );
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({ source: "explicit-approval" }),
        allowAlwaysDecision: {
          kind: "patterns",
          commandText: "sh -c 'git status'",
          patterns: [{ pattern: "/usr/bin/git", argPattern: expectedGitArgPattern }],
        },
      }),
    );
  });

  it.runIf(process.platform !== "win32")(
    "defers compound plans with more than 64 candidates before Guardian review",
    async () => {
      const command = Array.from({ length: 65 }, () => "/bin/echo ok").join(" && ");
      await configurePlanBackedCommand({ command });

      const result = await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true });

      expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
      expect(createExecApprovalRequestRouteMock).toHaveBeenCalledOnce();
      expect(result.deniedResult?.details.status).toBe("failed");
    },
  );

  it("does not use fallback-full when auto-review asks for human approval", async () => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    mockHostPolicy({ hostSecurity: "full", hostAsk: "on-miss", askFallback: "full" });
    defaultExecAutoReviewerMock.mockResolvedValue({
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
    expect(defaultExecAutoReviewerMock).toHaveBeenCalledOnce();
    expect(result.deniedResult?.details.status).toBe("failed");
    expect(result.deniedResult?.content[0]).toMatchObject({
      text: `Exec denied (gateway id=${approvalRouteFixture.id}, approval-timeout): echo ok`,
    });
  });

  it("allows durable exact-command trust to bypass the synchronous allowlist miss", async () => {
    const command = "/bin/echo durable";
    mockAllowlist({
      analysisOk: false,
      segments: [{ resolution: null, argv: ["/bin/echo", "durable"] }],
      segmentSatisfiedBy: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(true);
    hasExactCommandDurableExecApprovalMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: true,
      command,
    });
    mockExactTrust(command);

    const result = await runGatewayAllowlist({ command });

    expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      execCommandOverride: undefined,
      assertCurrent: expect.any(Function),
      revalidateBeforeExecution: expect.any(Function),
    });
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "current-policy",
          requireExactCommandApproval: true,
        }),
      }),
    );
  });

  it("keeps denying allowlist misses when durable trust does not match", async () => {
    mockAllowlist({
      analysisOk: false,
      segments: [{ resolution: null, argv: ["node", "--version"] }],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);

    await expect(
      runGatewayAllowlist({
        command: "node --version",
      }),
    ).rejects.toThrow("exec denied: allowlist miss");
  });

  it("keeps webchat diagnostics approvals as direct pasteable followups", async () => {
    approvalDecisionMock.mockResolvedValue("allow-once");
    const outcome = {
      status: "completed" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 12,
      timedOut: false,
      aggregated: JSON.stringify({
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
    };
    runExecProcessMock.mockResolvedValue({
      session: { id: "sess-1" },
      promise: Promise.resolve(outcome),
    });

    const approvalFollowup = vi.fn<ExecApprovalFollowupFactory>(async () =>
      [
        "OpenAI Codex harness:",
        "Codex diagnostics sent to OpenAI servers:",
        "Session 1",
        "Channel: telegram",
        "OpenClaw session id: `session-1`",
        "Codex thread id: `thread-1`",
      ].join("\n"),
    );

    const result = await runGatewayAllowlist({
      command: "openclaw gateway diagnostics export --json",
      trigger: "diagnostics",
      approvalFollowupMode: "direct",
      approvalFollowup,
      turnSourceChannel: "webchat",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce());
    expect(buildExecApprovalFollowupTargetMock.mock.calls[0]?.[0].direct).toBe(true);

    const followupTarget = sendExecApprovalFollowupResultMock.mock.calls[0]?.[0];
    expect(followupTarget?.direct).toBe(true);
    const followupText = requireSentFollowupText();
    expect(followupText).toContain("Diagnostics export created.");
    expect(followupText).toContain("Path: /tmp/openclaw-diagnostics.zip");
    expect(followupText).toContain("Contents (2 files):");
    expect(followupText).toContain("OpenAI Codex harness:");
    expect(followupText).toContain("Codex diagnostics sent to OpenAI servers:");
    expect(followupText).toContain("Codex thread id: `thread-1`");
    const approvalInput = approvalFollowup.mock.calls[0]?.[0];
    expect(approvalInput?.approvalId).toBe(approvalRouteFixture.id);
    expect(approvalInput?.sessionId).toBe("sess-1");
    expect(approvalInput?.trigger).toBe("diagnostics");
    expect(approvalInput?.outcome?.status).toBe("completed");
    expect(approvalInput?.outcome?.exitCode).toBe(0);
  });

  it("keeps a completed detached outcome terminal when agent follow-up registration fails", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();
    const completedOutcome = {
      status: "completed" as const,
      exitCode: 0,
      timedOut: false,
      aggregated: "completed output",
    };
    const approvalFollowup = vi.fn<ExecApprovalFollowupFactory>(() => undefined);
    mockApprovedDetachedExec({ outcome: completedOutcome });
    sendExecApprovalFollowupResultMock.mockRejectedValueOnce(
      new Error("synchronous runtime-handoff registration failure"),
    );

    try {
      const result = await runGatewayAllowlist({
        command: "side-effecting-command",
        approvalFollowupMode: "agent",
        approvalFollowup,
        turnSourceChannel: "webchat",
      });

      expect(result.pendingResult?.details.status).toBe("approval-pending");
      await vi.waitFor(() => expect(approvalFollowup).toHaveBeenCalledOnce());
      await setImmediate();

      expect(approvalFollowup.mock.calls[0]?.[0].outcome).toEqual(completedOutcome);
      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
      expect(requireSentFollowupText()).toContain("completed output");
      expect(requireSentFollowupText()).not.toContain("Exec denied");
    } finally {
      unhandledRejections.restore();
    }
  });

  it("consumes rejected detached request-failure and fallback follow-ups", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();
    approvalDecisionMock.mockRejectedValueOnce(new Error("approval request failed"));
    sendExecApprovalFollowupResultMock.mockRejectedValue(new Error("denial follow-up failed"));
    try {
      const result = await runGatewayAllowlist({
        command: "side-effecting-command",
        approvalFollowupMode: "agent",
        turnSourceChannel: "webchat",
      });
      expect(result.pendingResult?.details.status).toBe("approval-pending");
      await vi.waitFor(() => expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(2));
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

  it("keeps multiline gateway approval follow-up output intact", async () => {
    mockHostPolicy({ hostAsk: "always" });
    const aggregated = "first line\r\n\tindented\n\nlast line  \t\n";
    mockApprovedDetachedExec({
      outcome: {
        status: "completed",
        exitCode: 0,
        timedOut: false,
        aggregated,
      },
    });

    const result = await runGatewayAllowlist({
      command: "openclaw sessions export-trajectory --json",
      approvalFollowupMode: "agent",
      sessionId: "approval-session",
      sessionStore: "/tmp/openclaw-sessions.json",
      turnSourceChannel: "webchat",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce());
    const text = requireSentFollowupText();
    expect(text).toContain(aggregated);
    // The compact notify formatter would have collapsed every run of whitespace.
    expect(text).not.toContain("first line indented last line");
  });

  it("fails closed when a detached allow-always authorization commit fails", async () => {
    approvalDecisionMock.mockResolvedValue("allow-always");
    commitExecAuthorizationMock.mockRejectedValueOnce(new Error("approval lock unavailable"));
    const captured = captureSecurityEvents();
    try {
      const result = await runGatewayAllowlist({
        approvalFollowupMode: "agent",
        command: "echo approved",
      });
      expect(result.pendingResult?.details.status).toBe("approval-pending");
      await vi.waitFor(() => expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce());
      expect(requireSentFollowupText()).toContain("approval-state-write-failed");
      expect(runExecProcessMock).not.toHaveBeenCalled();
      expect(commitExecAuthorizationMock).toHaveBeenCalledOnce();
      expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          authorization: expect.objectContaining({ source: "explicit-approval" }),
          allowAlwaysDecision: expect.any(Object),
        }),
      );
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
    commitExecAuthorizationMock.mockImplementation(async () => {
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

    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      turnSourceChannel: "feishu",
      approvalFollowupMode: "agent",
    });
    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(approvalDecisionMock).toHaveBeenCalledOnce();
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    approval.resolve("allow-once");
    await Promise.resolve();
    await Promise.resolve();
    expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(markBackgroundedMock).not.toHaveBeenCalled();

    suspension?.release();
    await spawnStarted.promise;
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    spawnAllowed.resolve();
    await vi.waitFor(() => {
      expect(markBackgroundedMock).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    expect(commitExecAuthorizationMock).toHaveBeenCalledOnce();
    expect(runExecProcessMock).toHaveBeenCalledOnce();

    outcome.resolve({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      aggregated: "done",
    });
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
    });
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

      const result = await runGatewayAllowlist({
        command,
        workdir,
        turnSourceChannel: "feishu",
        approvalFollowupMode: "agent",
      });

      expect(result.pendingResult?.details.status).toBe("approval-pending");
      expect(buildExecApprovalPendingToolResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ allowedDecisions: ["allow-once", "deny"] }),
      );
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
      });
      expect(requireSentFollowupText()).toContain(
        "approval script operand changed before execution",
      );
      expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
      expect(runExecProcessMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("denies a detached approved process when restart drain wins admission", async () => {
    const approval = createDeferredCore<ExecApprovalDecision>();
    approvalDecisionMock.mockReturnValue(approval.promise);

    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      turnSourceChannel: "feishu",
      approvalFollowupMode: "agent",
    });
    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(approvalDecisionMock).toHaveBeenCalledOnce();
    });

    markGatewayRestartDraining();
    approval.resolve("allow-once");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.anything(),
        `Exec denied (gateway id=${approvalRouteFixture.id}, gateway-draining): find . -maxdepth 1`,
      );
    });
    expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
    expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(markBackgroundedMock).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "resolves a rotated GitHub credential only after delayed approval",
    async () => {
      const followupDelivered = createDeferredCore();
      sendExecApprovalFollowupResultMock.mockImplementation(async () => {
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
        const result = await runGatewayAllowlist({
          command,
          turnSourceChannel: "feishu",
          approvalFollowupMode: "agent",
          env,
          requestedEnv: env,
          githubProfileDir: profileDir,
        });
        expect(result.pendingResult?.details.status).toBe("approval-pending");
        await vi.waitFor(() => expect(approvalDecisionMock).toHaveBeenCalledOnce());
        expect(startupCancellationMocks.spawn).not.toHaveBeenCalled();
        fs.writeFileSync(hostsPath, "github.com:\n  oauth_token: synthetic-after-approval\n");
        releaseApproval();
        await followupDelivered.promise;
        expect(sendExecApprovalFollowupResultMock.mock.calls.length).toBe(1);
        expect(requireSentFollowupText()).toContain("selected-after-approval");
        expect(startupCancellationMocks.spawn).toHaveBeenCalledOnce();
        expect(env.GH_TOKEN).toBe("");
        expect(JSON.stringify(createExecApprovalRequestRouteMock.mock.calls)).not.toContain(
          "synthetic-after-approval",
        );
        expect(JSON.stringify(sendExecApprovalFollowupResultMock.mock.calls)).not.toContain(
          "synthetic-after-approval",
        );
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
    mockApprovedDetachedExec({
      outcome: { status: "completed", exitCode: 0, timedOut: false, aggregated: "done" },
    });
    const runtime = await vi.importActual<typeof import("./bash-tools.exec-runtime.js")>(
      "./bash-tools.exec-runtime.js",
    );
    runExecProcessMock.mockImplementation(runtime.runExecProcess);
    startupCancellationMocks.prepare.mockImplementationOnce(() =>
      controller.abort(new Error("cancelled while preparing")),
    );

    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      turnSourceChannel: "feishu",
      approvalFollowupMode: "agent",
      signal: controller.signal,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => expect(startupCancellationMocks.prepare).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(startupCancellationMocks.spawn.mock.calls.length).toBe(0);
    expect(markBackgroundedMock).not.toHaveBeenCalled();
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
  });

  it("drops detached execution and follow-up when the owning run is aborted", async () => {
    approvalDecisionMock.mockRejectedValue(runAbortedApprovalError);

    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      turnSourceChannel: "feishu",
      approvalFollowupMode: "agent",
      runId: "run-aborted",
      toolCallId: "tool-aborted",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(approvalDecisionMock).toHaveBeenCalledOnce();
    });
    expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
  });

  it("binds a full-policy timeout to the current allowlist fallback plan", async () => {
    const { command, enforcedCommand } = await mockAllowlistTimeoutFallback("full");
    approvalDecisionMock.mockResolvedValue(null);
    const result = await runGatewayAllowlist({
      command,
      security: "full",
      ask: "always",
      turnSourceChannel: "webchat",
    });

    expect(result.execCommandOverride).toBe(enforcedCommand);
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "ask-fallback",
          security: "allowlist",
          allowlistSatisfied: true,
        }),
      }),
    );
  });

  it("commits a headless allowlist timeout fallback before returning its bound plan", async () => {
    const { command, enforcedCommand } = await mockAllowlistTimeoutFallback("full");
    approvalRouteFixture.inline = true;

    const result = await runGatewayAllowlist({
      command,
      security: "full",
      ask: "always",
      trigger: "cron",
    });

    expect(result.execCommandOverride).toBe(enforcedCommand);
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "ask-fallback",
          security: "allowlist",
          allowlistSatisfied: true,
        }),
      }),
    );
  });

  it("denies allowlist timeout fallback without an enforceable plan", async () => {
    requiresExecApprovalMock.mockReturnValue(true);
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
    expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
  });

  describe("cron standing grants", () => {
    const CRON_STORE_KEY = "/tmp/openclaw-exec-host-cron-store";
    const grantCommand = "run-nightly-backup --verbose";
    const grantTempDirs: string[] = [];
    let stateDirBackup: string | undefined;
    let hadStateDirBackup = false;
    let workdir: string;
    let unregisterCronSource: (() => void) | undefined;

    beforeEach(() => {
      hadStateDirBackup = "OPENCLAW_STATE_DIR" in process.env;
      stateDirBackup = process.env.OPENCLAW_STATE_DIR;
      const stateDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-grant-state-")),
      );
      grantTempDirs.push(stateDir);
      process.env.OPENCLAW_STATE_DIR = stateDir;
      workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-grant-cwd-")));
      grantTempDirs.push(workdir);
      // Grants are consulted only when policy would otherwise prompt, before
      // any JSON allowlist digest can satisfy the command.
      requiresExecApprovalMock.mockReturnValue(true);
      hasDurableExecApprovalMock.mockReturnValue(false);
      mockHostPolicy({ hostAsk: "on-miss" });
    });

    afterEach(() => {
      unregisterCronSource?.();
      unregisterCronSource = undefined;
      closeOpenClawStateDatabaseForTest();
      if (hadStateDirBackup) {
        process.env.OPENCLAW_STATE_DIR = stateDirBackup;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
      for (const dir of grantTempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    function databaseOptions() {
      return { env: { ...process.env } };
    }

    function seedCronJobRow(): string {
      const database = openOpenClawStateDatabase(databaseOptions());
      // SAFETY: minimal valid cron job shape for the storage codec round-trip.
      const job = {
        id: "job-1",
        agentId: "main",
        name: "Nightly backup",
        enabled: true,
        createdAtMs: Date.now() - 1_000,
        updatedAtMs: Date.now() - 1_000,
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "run the backup" },
      } as CronStoredJob;
      upsertCronJobRow(database.db, CRON_STORE_KEY, job, 0);
      const loaded = loadedCronStoreFromRows(loadCronRows(database.db, CRON_STORE_KEY));
      const loadedJob = loaded.store.jobs.find((entry) => entry.id === "job-1");
      if (!loadedJob) {
        throw new Error("seeded cron job did not load back");
      }
      return resolveCronJobConfigRevision(loadedJob);
    }

    async function mintStandingGrant(revision: string): Promise<void> {
      await insertOperatorApproval({
        approval: {
          id: "cron-approval-1",
          kind: "exec",
          presentation: {
            kind: "exec",
            commandText: grantCommand,
            commandPreview: grantCommand,
            warningText: null,
            host: "gateway",
            nodeId: null,
            agentId: "main",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
          reviewerDeviceIds: [],
          source: {
            agentId: "main",
            sessionKey: "agent:main:cron:job-1",
            sessionId: "session-1",
            runId: "cron-run-0",
            toolCallId: null,
            toolName: "exec",
          },
          audienceSessionKeys: [],
          runtimeEpoch: "epoch-1",
          createdAtMs: Date.now() - 500,
          expiresAtMs: Date.now() + 60_000,
        },
        databaseOptions: databaseOptions(),
      });
      const resolved = await resolveOperatorApproval({
        id: "cron-approval-1",
        decision: "allow-always",
        resolver: { kind: "device", id: "reviewer-1" },
        databaseOptions: databaseOptions(),
        standingGrant: {
          kind: "cron",
          agentId: "main",
          cronJobId: "job-1",
          jobConfigRevision: revision,
          operationBinding: buildCronExecOperationBinding({
            command: grantCommand,
            cwd: workdir,
            env: undefined,
          }),
          expiresAtMs: null,
        },
      });
      expect(resolved.outcome).toBe("resolved");
    }

    function readGrantUseCounts(): number[] {
      const database = openOpenClawStateDatabase(databaseOptions());
      const stateDb = getNodeSqliteKysely<
        Pick<OpenClawStateKyselyDatabase, "operator_approval_standing_grants">
      >(database.db);
      return executeSqliteQuerySync(
        database.db,
        stateDb.selectFrom("operator_approval_standing_grants").select(["use_count"]),
      ).rows.map((row) => row.use_count);
    }

    async function prepareCronRun(mintGrant: boolean) {
      const revision = seedCronJobRow();
      if (mintGrant) {
        await mintStandingGrant(revision);
      }
      unregisterCronSource = registerCronRunExecSource("cron-run-1", {
        agentId: "main",
        jobId: "job-1",
        jobConfigRevision: revision,
        jobName: "Nightly backup",
      });
    }

    function runCron() {
      return runGatewayAllowlist({
        command: grantCommand,
        workdir,
        agentId: "main",
        runId: "cron-run-1",
        ask: "on-miss",
      });
    }

    it("executes a cron occurrence via a standing grant without prompting", async () => {
      await prepareCronRun(true);
      const security = captureSecurityEvents();
      const result = await runCron();
      expect(result.pendingResult).toBeUndefined();
      expect(result.deniedResult).toBeUndefined();
      expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
      // Authority is recorded at the final effect: validation skips the prompt
      // but the use is consumed only by the pre-spawn revalidation closure.
      expect(readGrantUseCounts()).toEqual([0]);
      expect(result.revalidateBeforeExecution).toBeDefined();
      await expect(result.revalidateBeforeExecution?.()).resolves.toBeUndefined();
      security.stop();
      expect(JSON.stringify(security.events)).toContain("standing-grant");
      expect(readGrantUseCounts()).toEqual([1]);
    });

    it("denies at the spawn boundary when the grant is invalidated after consult", async () => {
      await prepareCronRun(true);
      const security = captureSecurityEvents();
      const result = await runCron();
      expect(result.pendingResult).toBeUndefined();
      expect(result.deniedResult).toBeUndefined();
      expect(result.revalidateBeforeExecution).toBeDefined();
      // Revoke the parent approval between consult and spawn: the closure
      // must deny instead of executing on the stale authority.
      const database = openOpenClawStateDatabase(databaseOptions());
      // sqlite-allow-raw -- test-only reversal of the minting approval row.
      database.db
        .prepare("update operator_approvals set status = 'denied', decision = 'deny'")
        .run();
      const denied = await result.revalidateBeforeExecution?.();
      security.stop();
      expect(denied?.details.status).toBe("failed");
      expect(denied?.content[0]).toMatchObject({
        text: expect.stringContaining("standing grant no longer valid"),
      });
      expect(readGrantUseCounts()).toEqual([0]);
      expect(JSON.stringify(security.events)).toContain("standing-grant-invalidated");
    });

    it("skips the JSON allowlist digest when a cron allow-always resolves", async () => {
      await prepareCronRun(false);
      approvalDecisionMock.mockResolvedValue("allow-always");
      const result = await runCron();
      expect(result.pendingResult).toBeUndefined();
      expect(result.deniedResult).toBeUndefined();
      await vi.waitFor(() => expect(commitExecAuthorizationMock).toHaveBeenCalledOnce());
      expect(commitExecAuthorizationMock.mock.calls[0]?.[0].allowAlwaysDecision).toBeUndefined();
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
