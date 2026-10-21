/**
 * Node-host exec orchestration tests.
 * Covers node target resolution, remote prepare/invoke payloads, approvals,
 * auto-review, and follow-up execution paths.
 */
import crypto from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../packages/gateway-client/src/timeouts.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  requiresExecApproval,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalUnavailableDecisions,
} from "../infra/exec-approvals-policy.js";
import type { ExecAllowlistEntry } from "../infra/exec-approvals.types.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";

type ExecAutoReviewer = typeof import("../infra/exec-auto-review.js").defaultExecAutoReviewer;
type ExecAutoReviewDecision = Awaited<ReturnType<ExecAutoReviewer>>;
type ExecAsk = import("../infra/exec-approvals.js").ExecAsk;
type ExecSecurity = import("../infra/exec-approvals.js").ExecSecurity;
type MockAllowAlwaysPersistenceInput = Parameters<
  typeof import("../infra/exec-approvals.js").resolveAllowAlwaysPersistenceDecision
>[0];
type MockAllowAlwaysPersistenceDecision =
  import("../infra/exec-approvals.js").AllowAlwaysPersistenceDecision;
type MockAllowlistSegment = {
  raw?: string;
  resolution: null;
  argv: string[];
};
type MockAllowlistResult = {
  allowlistMatches: unknown[];
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  segments: MockAllowlistSegment[];
  segmentAllowlistEntries: unknown[];
  segmentSatisfiedBy?: unknown[];
};
type MockExecAllowlistEntry = {
  pattern: string;
  argPattern?: string;
  source?: "allow-always";
  commandText?: string;
};
type MockExecApprovalsResolved = {
  allowlist: MockExecAllowlistEntry[];
  file: { version: 1; agents: Record<string, unknown> };
  agent: {
    security: ExecSecurity;
    ask: ExecAsk;
    askFallback?: "deny";
    autoAllowSkills?: false;
  };
};
type ShellAllowlistMockParams = {
  command?: string;
  allowlist?: unknown[];
  env?: NodeJS.ProcessEnv;
};
type ApprovalState = {
  approvedByAsk: boolean;
  deniedReason: string | null;
  timeoutContext?: unknown;
};
type ApprovalOutcome =
  | { kind: "request-failed" | "run-aborted" }
  | { kind: "resolved"; decision: string | null; state: ApprovalState };
type ApprovalWaitParams = {
  resolveTimedOut: () => Promise<{
    approvedByAsk: boolean;
    deniedReason: string | null;
    context?: unknown;
  }>;
  requiresExplicitApproval: (context: unknown) => boolean;
  requiresAutoReviewHumanApproval?: boolean;
};
type ApprovalRouteParams = ApprovalWaitParams & { register: (id: string) => Promise<void> };
type ApprovalRoute = {
  approvalId: string;
  approvalSlug: string;
  warningText: string;
  expiresAtMs: number;
  preResolvedDecision: null;
  initiatingSurface: string;
  sentApproverDms: boolean;
  unavailableReason: null;
} & ({ kind: "wait" } | { kind: "inline"; state: ApprovalState });

const INLINE_EVAL_HIT = {
  executable: "python3",
  normalizedExecutable: "python3",
  flag: "-c",
  argv: ["python3", "-c", "print(1)"],
};

const preparedPlan = vi.hoisted(() => ({
  argv: ["/usr/local/bin/bun", "./script.ts"],
  cwd: "/tmp/work",
  commandText: "/usr/local/bin/bun ./script.ts",
  commandPreview: "bun ./script.ts",
  agentId: "prepared-agent",
  sessionKey: "prepared-session",
  policySnapshot: {
    security: "full" as const,
    ask: "off" as const,
    askFallback: "deny" as const,
    autoAllowSkills: false,
    allowlistRules: [{ pattern: "/usr/local/bin/bun" }],
  },
  mutableFileOperand: {
    argvIndex: 1,
    path: "/tmp/work/script.ts",
    sha256: "abc123",
  },
}));
const nodeCommandMarker = vi.hoisted(() => "=node-command:test");
const exactCommandMarker = (commandText: string): string =>
  `=command:${crypto.createHash("sha256").update(commandText).digest("hex").slice(0, 16)}`;

const callGatewayToolMock = vi.hoisted(() => vi.fn());
const listNodesMock = vi.hoisted(() => vi.fn());
const parsePreparedSystemRunPayloadMock = vi.hoisted(() => vi.fn());
const evaluateShellAllowlistMock = vi.hoisted(() =>
  vi.fn<(raw?: ShellAllowlistMockParams) => MockAllowlistResult>(),
);
const hasNodeCommandAllowAlwaysMarkerMock = vi.hoisted(() =>
  vi.fn((raw: unknown): boolean =>
    ((raw as { allowlist?: Array<{ pattern?: string }> }).allowlist ?? []).some(
      (entry) => entry.pattern === "=node-command:test",
    ),
  ),
);
const resolveAllowAlwaysPatternCoverageMock = vi.hoisted(() => vi.fn<(raw: unknown) => unknown>());
const resolveExecApprovalsFromFileMock = vi.hoisted(() => vi.fn<() => MockExecApprovalsResolved>());
const requiresExecApprovalMock = vi.hoisted(() => vi.fn<typeof requiresExecApproval>());
const hasDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => false));
const resolveAllowAlwaysPersistenceDecisionMock = vi.hoisted(() =>
  vi.fn<(raw: MockAllowAlwaysPersistenceInput) => MockAllowAlwaysPersistenceDecision>(),
);
const resolveExecApprovalAllowedDecisionsMock = vi.hoisted(() =>
  vi.fn<typeof resolveExecApprovalAllowedDecisions>(),
);
const resolveExecApprovalUnavailableDecisionsMock = vi.hoisted(() =>
  vi.fn<typeof resolveExecApprovalUnavailableDecisions>(),
);
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    approvals: { allowlist: [] as ExecAllowlistEntry[], file: { version: 1, agents: {} } },
    hostSecurity: "full",
    hostAsk: "off",
    askFallback: "deny",
  })),
);
const inlineApproval = vi.hoisted(() => ({ enabled: false }));
const createExecApprovalRequestRouteMock = vi.hoisted(() =>
  vi.fn<(params: ApprovalRouteParams) => Promise<ApprovalRoute>>(),
);
const resolveExecApprovalWaitOutcomeMock = vi.hoisted(() =>
  vi.fn<(params: ApprovalWaitParams) => Promise<ApprovalOutcome>>(),
);
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const sendExecApprovalFollowupResultMock = vi.hoisted(() =>
  vi.fn(async (_target: unknown, _resultText: string) => undefined),
);
const registerExecApprovalRequestForHostOrThrowMock = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
const detectInterpreterInlineEvalArgvMock = vi.hoisted(() =>
  vi.fn(
    (): {
      executable: string;
      normalizedExecutable: string;
      flag: string;
      argv: string[];
    } | null => null,
  ),
);

vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  countObsoleteGeneratedExecApprovalRules: vi.fn(() => 0),
  evaluateShellAllowlist: evaluateShellAllowlistMock,
  evaluateShellAllowlistWithAuthorization: evaluateShellAllowlistMock,
  hasDurableExecApproval: hasDurableExecApprovalMock,
  hasNodeCommandAllowAlwaysMarker: hasNodeCommandAllowAlwaysMarkerMock,
  requiresExecApproval: requiresExecApprovalMock,
  resolveAllowAlwaysPersistenceDecision: resolveAllowAlwaysPersistenceDecisionMock,
  resolveAllowAlwaysPatternCoverage: resolveAllowAlwaysPatternCoverageMock,
  resolveExecApprovalAllowedDecisions: resolveExecApprovalAllowedDecisionsMock,
  resolveExecApprovalUnavailableDecisions: resolveExecApprovalUnavailableDecisionsMock,
  resolveExecApprovalsFromFile: resolveExecApprovalsFromFileMock,
}));

vi.mock("../infra/command-analysis/inline-eval.js", () => ({
  describeInterpreterInlineEval: vi.fn(() => "inline-eval"),
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

vi.mock("../infra/node-shell.js", () => ({
  buildNodeShellCommand: vi.fn(() => ["/bin/sh", "-lc", "bun ./script.ts"]),
}));

vi.mock("../infra/system-run-approval-context.js", () => ({
  parsePreparedSystemRunPayload: parsePreparedSystemRunPayloadMock,
}));

vi.mock("./bash-tools.exec-approval-request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-approval-request.js")>()),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: registerExecApprovalRequestForHostOrThrowMock,
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
  createExecApprovalRequestRoute: createExecApprovalRequestRouteMock,
  resolveExecApprovalWaitOutcome: resolveExecApprovalWaitOutcomeMock,
  sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  createApprovalSlug: vi.fn(() => "slug"),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
}));

vi.mock("./tools/nodes-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools/nodes-utils.js")>()),
  listNodes: listNodesMock,
}));

vi.mock("../logger.js", () => ({
  logInfo: vi.fn(),
}));

function run(overrides: Partial<ExecuteNodeHostCommandParams> = {}) {
  return executeNodeHostCommand({
    command: "bun ./script.ts",
    workdir: "/tmp/work",
    env: {},
    security: "full",
    ask: "off",
    defaultTimeoutSec: 30,
    approvalRunningNoticeMs: 0,
    warnings: [],
    agentId: "requested-agent",
    sessionKey: "requested-session",
    ...overrides,
  });
}

type MockNodeInvokeParams = {
  command?: string;
  timeoutMs?: number;
  params?: Record<string, unknown>;
};

type GatewayToolCall = {
  method: string;
  options: { timeoutMs?: number };
  params?: MockNodeInvokeParams;
  callOptions?: unknown;
};

function requireGatewayCommand(command: string): GatewayToolCall {
  const call = callGatewayToolMock.mock.calls.find(
    ([method, , params]) =>
      method === "node.invoke" && (params as MockNodeInvokeParams | undefined)?.command === command,
  );
  if (!call) {
    throw new Error(`expected gateway command ${command}`);
  }
  const [method, options, params, callOptions] = call as [
    string,
    { timeoutMs?: number },
    MockNodeInvokeParams | undefined,
    unknown,
  ];
  return { method, options, params, callOptions };
}

function requireRunParams(call: GatewayToolCall): Record<string, unknown> {
  expect(call.method).toBe("node.invoke");
  expect(call.params?.command).toBe("system.run");
  const params = call.params?.params;
  if (!params) {
    throw new Error("expected system.run params");
  }

  return params;
}

function expectNoSystemRun() {
  expect(
    callGatewayToolMock.mock.calls.some(
      ([method, , params]) =>
        method === "node.invoke" &&
        (params as MockNodeInvokeParams | undefined)?.command === "system.run",
    ),
  ).toBe(false);
}

function createNodeInvokeFailure(params: {
  code: string;
  nodeCommandDispatched?: boolean;
  message?: string;
}): Error {
  return Object.assign(new Error(params.message ?? "node invoke failed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "UNAVAILABLE",
    details: {
      nodeError: {
        code: params.code,
        message: params.message ?? "node invoke failed",
      },
      ...(params.nodeCommandDispatched !== undefined
        ? { nodeCommandDispatched: params.nodeCommandDispatched }
        : {}),
    },
  });
}

function requireRegisteredApprovalRequest(): Record<string, unknown> {
  const calls = registerExecApprovalRequestForHostOrThrowMock.mock.calls as unknown as [
    Record<string, unknown>,
  ][];
  const firstCall = calls[0];
  if (!firstCall) {
    throw new Error("expected approval request registration");
  }
  return firstCall[0];
}

function expectSystemRunInvoke(params: {
  invokeDeadlineMs: number;
  invokeWaitMs: number;
  runTimeoutMs: number;
}) {
  const call = requireGatewayCommand("system.run");
  // Three ordered budgets: node program runtime < Gateway invocation deadline <
  // caller wait, so the Gateway deadline answer wins over a caller giving up.
  expect(requireRunParams(call).timeoutMs).toBe(params.runTimeoutMs);
  expect(call.params?.timeoutMs).toBe(params.invokeDeadlineMs);
  expect(call.options.timeoutMs).toBe(params.invokeWaitMs);
  expect(params.runTimeoutMs).toBeLessThanOrEqual(params.invokeDeadlineMs);
  expect(params.invokeDeadlineMs).toBeLessThanOrEqual(params.invokeWaitMs);
  expect(params.invokeDeadlineMs).toBeGreaterThan(0);
  expect(Number.isFinite(params.invokeWaitMs)).toBe(true);
}

function createNodeGatewayHandler(params: {
  approvals: Record<string, unknown> | Error;
  allowApprovalResolve?: boolean;
  execPolicy?: { security: string; ask: string };
  stderr?: string;
  stdout?: string;
}) {
  return async (method: string, _options: unknown, invoke: MockNodeInvokeParams | undefined) => {
    if (method === "exec.approvals.node.get") {
      if (params.approvals instanceof Error) {
        throw params.approvals;
      }
      return { file: params.approvals };
    }
    if (method === "exec.approval.resolve" && params.allowApprovalResolve) {
      return { payload: {} };
    }
    if (method !== "node.invoke") {
      throw new Error(`unexpected gateway method: ${method}`);
    }
    if (invoke?.command === "system.run.prepare") {
      return {
        payload: {
          plan: preparedPlan,
          ...(params.execPolicy ? { execPolicy: params.execPolicy } : {}),
        },
      };
    }
    if (invoke?.command === "system.run") {
      return {
        payload: {
          success: true,
          stdout: params.stdout ?? "ok",
          stderr: params.stderr ?? "",
          exitCode: 0,
          timedOut: false,
        },
      };
    }
    throw new Error(`unexpected node invoke command: ${String(invoke?.command)}`);
  };
}

function mockGatewayInvokesWithNodeApprovals(file: Record<string, unknown>) {
  callGatewayToolMock.mockImplementation(createNodeGatewayHandler({ approvals: file }));
}

function buildAllowlistEvalResult(params?: {
  allowlistSatisfied?: boolean;
  segmentAllowlistEntry?: { pattern: string } | null;
}) {
  return {
    allowlistMatches:
      params?.allowlistSatisfied && params.segmentAllowlistEntry
        ? [params.segmentAllowlistEntry]
        : [],
    analysisOk: true,
    allowlistSatisfied: params?.allowlistSatisfied === true,
    segments: [segment(["tool", "--version"])],
    segmentAllowlistEntries:
      params?.allowlistSatisfied && params.segmentAllowlistEntry
        ? [params.segmentAllowlistEntry]
        : [null],
    segmentSatisfiedBy: [params?.allowlistSatisfied ? "allowlist" : null],
  };
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

const fullNodePolicy: MockExecApprovalsResolved["agent"] = {
  security: "full",
  ask: "off",
  askFallback: "deny",
  autoAllowSkills: false,
};

function createNodeApprovals(
  allowlist: MockExecAllowlistEntry[],
  agent: MockExecApprovalsResolved["agent"] = { security: "allowlist", ask: "on-miss" },
): MockExecApprovalsResolved {
  return { allowlist, agent, file: { version: 1, agents: {} } };
}

function allowReviewer(risk: "low" | "medium" = "low") {
  return vi.fn<ExecAutoReviewer>(async () => ({
    decision: "allow-once",
    risk,
    rationale: "safe command",
  }));
}

function approvedOutcome(
  decision: string | null = "allow-once",
  state: ApprovalState = { approvedByAsk: true, deniedReason: null },
): ApprovalOutcome {
  return { kind: "resolved", decision, state };
}

function useTimeout(deniedBy?: "human" | "inline") {
  resolveExecApprovalWaitOutcomeMock.mockImplementation(async (params) => {
    const fallback = await params.resolveTimedOut();
    if (deniedBy) {
      expect(
        deniedBy === "human"
          ? params.requiresAutoReviewHumanApproval
          : params.requiresExplicitApproval(fallback.context),
      ).toBe(true);
    }
    return approvedOutcome(null, {
      approvedByAsk: deniedBy ? false : fallback.approvedByAsk,
      deniedReason: deniedBy ? "approval-timeout" : fallback.deniedReason,
      timeoutContext: fallback.context,
    });
  });
}

function analysis(
  segments: MockAllowlistSegment[],
  overrides: Partial<Omit<MockAllowlistResult, "segments">> = {},
): MockAllowlistResult {
  return {
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: false,
    segments,
    segmentAllowlistEntries: [],
    ...overrides,
  };
}

function segment(argv: string[], raw?: string): MockAllowlistSegment {
  return { resolution: null, argv, ...(raw === undefined ? {} : { raw }) };
}

function nodePlan(
  argv: string[],
  commandText: string,
  commandPreview: string | null = commandText,
) {
  return {
    argv,
    cwd: "/tmp/work",
    commandText,
    commandPreview,
    agentId: "prepared-agent",
    sessionKey: "prepared-session",
  };
}

function setHostPolicy(...args: Parameters<typeof createHostPolicy>) {
  resolveExecHostApprovalContextMock.mockReturnValue(createHostPolicy(...args));
}

function runReviewed(overrides: Partial<ExecuteNodeHostCommandParams>) {
  return run({ security: "allowlist", ask: "on-miss", autoReview: true, ...overrides });
}

function useUnsatisfiedApprovalRequirement() {
  requiresExecApprovalMock.mockImplementation(
    (params) => params?.allowlistSatisfied !== true && params?.durableApprovalSatisfied !== true,
  );
}

function setNodeApprovals(...args: Parameters<typeof createNodeApprovals>) {
  resolveExecApprovalsFromFileMock.mockReturnValue(createNodeApprovals(...args));
}

function preparePlan(plan: ReturnType<typeof nodePlan> | typeof preparedPlan) {
  parsePreparedSystemRunPayloadMock.mockReturnValue({
    plan,
    execPolicy: { security: "full", ask: "off" },
  });
}

function createHostPolicy(
  hostSecurity: ExecSecurity,
  hostAsk: ExecAsk,
  askFallback: ExecSecurity = "deny",
): ReturnType<typeof resolveExecHostApprovalContextMock> {
  return {
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity,
    hostAsk,
    askFallback,
  };
}

describe("executeNodeHostCommand", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
    callGatewayToolMock.mockImplementation(
      createNodeGatewayHandler({
        approvals: { version: 1, agents: {} },
        allowApprovalResolve: true,
      }),
    );
    listNodesMock.mockReset();
    listNodesMock.mockResolvedValue([
      {
        nodeId: "node-1",
        commands: ["system.run", "system.run.prepare"],
        connected: true,
        platform: process.platform,
      },
    ]);
    parsePreparedSystemRunPayloadMock.mockReset();
    preparePlan(preparedPlan);

    evaluateShellAllowlistMock.mockReset();
    evaluateShellAllowlistMock.mockReturnValue(
      analysis([segment(["/usr/local/bin/bun", "./script.ts"])]),
    );
    hasNodeCommandAllowAlwaysMarkerMock.mockClear();
    resolveAllowAlwaysPatternCoverageMock.mockReset();
    resolveAllowAlwaysPatternCoverageMock.mockReturnValue({
      complete: true,
      patterns: [{ pattern: "/trusted/bin/tool" }],
    });
    hasDurableExecApprovalMock.mockReset();
    hasDurableExecApprovalMock.mockReturnValue(false);
    resolveExecApprovalsFromFileMock.mockReset();
    setNodeApprovals([], fullNodePolicy);
    requiresExecApprovalMock.mockReset();
    requiresExecApprovalMock.mockImplementation(requiresExecApproval);
    resolveAllowAlwaysPersistenceDecisionMock.mockReset();
    resolveAllowAlwaysPersistenceDecisionMock.mockReturnValue({
      kind: "patterns",
      patterns: [{ pattern: "/trusted/bin/tool" }],
    });
    resolveExecApprovalAllowedDecisionsMock
      .mockReset()
      .mockImplementation(resolveExecApprovalAllowedDecisions);
    resolveExecApprovalUnavailableDecisionsMock
      .mockReset()
      .mockImplementation(resolveExecApprovalUnavailableDecisions);
    resolveExecHostApprovalContextMock.mockReset();
    setHostPolicy("full", "off");
    inlineApproval.enabled = false;
    resolveExecApprovalWaitOutcomeMock.mockReset().mockResolvedValue(approvedOutcome());
    createExecApprovalRequestRouteMock.mockReset().mockImplementation(async (params) => {
      await params.register("approval-1");
      const request = {
        approvalId: "approval-1",
        approvalSlug: "slug-1",
        warningText: "",
        expiresAtMs: Date.now() + 60_000,
        preResolvedDecision: null,
        initiatingSurface: "origin",
        sentApproverDms: false,
        unavailableReason: null,
      };
      if (!inlineApproval.enabled) {
        return { ...request, kind: "wait" };
      }
      const outcome = await resolveExecApprovalWaitOutcomeMock(params);
      if (outcome.kind !== "resolved") {
        throw new Error("expected inline approval state");
      }
      return { ...request, kind: "inline", state: outcome.state };
    });
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      content: [],
      details: { status: "approval-pending" },
    });
    sendExecApprovalFollowupResultMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    registerExecApprovalRequestForHostOrThrowMock.mockReset();
  });

  it("denies non-interactive approval requests without creating operator events", async () => {
    setHostPolicy("full", "always");
    const result = await run({
      ask: "always",
      nonInteractiveApproval: true,
      agentId: "collector",
      sessionKey: "agent:collector:subagent:child",
    });

    expect(result.details).toMatchObject({
      status: "failed",
      failureKind: "approval_required",
    });
    expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
  });

  it("consumes rejected detached node approval recovery and fallback follow-ups", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      resolveExecApprovalWaitOutcomeMock.mockResolvedValueOnce({ kind: "request-failed" });
      sendExecApprovalFollowupResultMock.mockRejectedValue(
        new Error("approval failure follow-up unavailable"),
      );
      setHostPolicy("full", "always");

      const result = await run({ approvalFollowupMode: "agent" });

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(2));
      await setImmediate();
      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ approvalId: "approval-1" }),
        "Exec denied (node=node-1 id=approval-1, approval-request-failed): bun ./script.ts",
      );
      expect(sendExecApprovalFollowupResultMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ approvalId: "approval-1" }),
        "Exec denied (node=node-1 id=approval-1, approval-request-failed): bun ./script.ts",
      );
      expectNoSystemRun();
    } finally {
      unhandledRejections.restore();
    }
  });

  it("never replaces a detached outcome-unknown result with denial when delivery fails", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();
    const defaultImplementation = callGatewayToolMock.getMockImplementation();

    try {
      callGatewayToolMock.mockImplementation(
        async (method: string, options: unknown, callParams: MockNodeInvokeParams | undefined) => {
          if (method === "node.invoke" && callParams?.command === "system.run") {
            throw createNodeInvokeFailure({
              code: "DISCONNECTED",
              nodeCommandDispatched: true,
              message: "node disconnected",
            });
          }
          if (!defaultImplementation) {
            throw new Error("missing default gateway mock");
          }
          return await defaultImplementation(method, options, callParams);
        },
      );
      sendExecApprovalFollowupResultMock.mockRejectedValueOnce(
        new Error("outcome-unknown follow-up unavailable"),
      );
      setHostPolicy("full", "always");

      const result = await run({ approvalFollowupMode: "agent", ask: "always" });

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalled();
      });
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        expect.stringContaining(
          "Exec outcome unknown (node=node-1 id=approval-1, outcome-unknown)",
        ),
      );
    } finally {
      unhandledRejections.restore();
    }
  });

  it("drops a detached node approval when its waiter reports a cancelled run", async () => {
    const pendingDecision = createDeferred<ApprovalOutcome>();
    const abortController = new AbortController();
    resolveExecApprovalWaitOutcomeMock.mockReturnValueOnce(pendingDecision.promise);
    setHostPolicy("full", "always");

    const result = await run({ approvalFollowupMode: "agent", signal: abortController.signal });

    expect(result.details?.status).toBe("approval-pending");
    expect(resolveExecApprovalWaitOutcomeMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ signal: abortController.signal }),
    );
    abortController.abort();
    pendingDecision.resolve({ kind: "run-aborted" });
    await setImmediate();

    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
    expectNoSystemRun();
  });

  it("drops a detached node approval cancelled during final policy revalidation", async () => {
    const abortController = new AbortController();
    const policy = createHostPolicy("full", "always");
    const policyCheckpoint = createDeferred<typeof policy>();
    resolveExecHostApprovalContextMock
      .mockReturnValueOnce(policy)
      .mockImplementationOnce(
        () =>
          policyCheckpoint.promise as unknown as ReturnType<
            typeof resolveExecHostApprovalContextMock
          >,
      );

    const result = await run({ approvalFollowupMode: "agent", signal: abortController.signal });

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
    });
    abortController.abort();
    policyCheckpoint.resolve(policy);
    await setImmediate();

    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
    expectNoSystemRun();
  });

  it("forwards prepared systemRunPlan within the native turn after approval", async () => {
    setHostPolicy("full", "always");

    const result = await run({
      toolCallId: "tool-node",
      turnSourceChannel: "telegram",
      turnSourceTo: "telegram:12345",
      turnSourceAccountId: "work",
      turnSourceThreadId: "42",
    });

    expect(result.details?.status).toBe("completed");
    expect(requireRegisteredApprovalRequest()).toMatchObject({
      systemRunPlan: preparedPlan,
      toolCallId: "tool-node",
    });

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    });

    const call = requireGatewayCommand("system.run");
    expect(call.options.timeoutMs).toBe(40_000);
    expect(call.params?.timeoutMs).toBe(35_000);
    expect(call.callOptions).toEqual({
      scopes: ["operator.write", "operator.approvals"],
      dispatchAuthority: {
        version: 2,
        kind: "source-bound",
        assertCurrent: expect.any(Function),
      },
    });
    const runParams = requireRunParams(call);
    expect(runParams.approved).toBe(true);
    expect(runParams.approvalDecision).toBe("allow-once");
    expect(runParams.approvalSource).toBeUndefined();
    expect(runParams.systemRunPlan).toEqual(preparedPlan);
    expect(runParams.timeoutMs).toBe(30_000);
    expect(runParams.turnSourceChannel).toBe("telegram");
    expect(runParams.turnSourceTo).toBe("telegram:12345");
    expect(runParams.turnSourceAccountId).toBe("work");
    expect(runParams.turnSourceThreadId).toBe("42");
    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
  });

  it("silently drops a detached node invocation cancelled during gateway dispatch", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      const abortController = new AbortController();
      const pendingInvocation = createDeferred<{
        payload: { success: boolean; stdout: string; exitCode: number };
      }>();
      setHostPolicy("full", "always");
      callGatewayToolMock.mockImplementation(
        async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
          if (method === "exec.approvals.node.get") {
            return { file: { version: 1, agents: {} } };
          }
          if (method === "node.invoke" && params?.command === "system.run.prepare") {
            return { payload: { plan: preparedPlan } };
          }
          if (method === "node.invoke" && params?.command === "system.run") {
            return pendingInvocation.promise;
          }
          throw new Error(`unexpected gateway method: ${method}`);
        },
      );

      const result = await run({ approvalFollowupMode: "agent", signal: abortController.signal });

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(requireGatewayCommand("system.run").callOptions).toEqual({
          scopes: ["operator.write", "operator.approvals"],
          signal: abortController.signal,
          dispatchAuthority: {
            version: 2,
            kind: "source-bound",
            assertCurrent: expect.any(Function),
          },
        });
      });
      abortController.abort(new Error("run aborted during node invocation"));
      pendingInvocation.reject(abortController.signal.reason);
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
    } finally {
      unhandledRejections.restore();
    }
  });

  it("does not dispatch an async human approval after gateway policy revocation", async () => {
    resolveExecHostApprovalContextMock
      .mockReturnValueOnce(createHostPolicy("full", "always"))
      .mockReturnValueOnce(createHostPolicy("deny", "always"));

    const result = await run({ approvalFollowupMode: "agent" });

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        "Exec denied (node=node-1 id=approval-1, invoke-failed): bun ./script.ts",
      );
    });
    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
    expectNoSystemRun();
  });

  it("does not dispatch an auto-reviewed command after gateway policy requires a human", async () => {
    const autoReviewer = allowReviewer();
    resolveExecHostApprovalContextMock
      .mockReturnValueOnce(createHostPolicy("allowlist", "on-miss"))
      .mockReturnValueOnce(createHostPolicy("allowlist", "always"));

    await expect(
      runReviewed({
        autoReviewer,
      }),
    ).rejects.toThrow("ask=always requires human approval");

    expect(autoReviewer).toHaveBeenCalledTimes(1);
    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
    expectNoSystemRun();
  });

  it.each(["allowlist", "exact-command", "headless"] as const)(
    "tags %s timeout fallback provenance without a human grant",
    async (kind) => {
      const headless = kind === "headless";
      const exact = kind === "exact-command";
      const command = exact ? preparedPlan.commandText : "tool --version";
      if (!headless) {
        const entry = exact
          ? {
              pattern: exactCommandMarker(command),
              source: "allow-always" as const,
              commandText: command,
            }
          : { pattern: "/trusted/bin/tool" };
        evaluateShellAllowlistMock.mockReturnValue(
          buildAllowlistEvalResult({ allowlistSatisfied: !exact, segmentAllowlistEntry: entry }),
        );
        hasDurableExecApprovalMock.mockReturnValue(exact);
        setNodeApprovals([entry], {
          security: "allowlist",
          ask: exact ? "always" : "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
        });
      } else {
        inlineApproval.enabled = true;
      }
      setHostPolicy(headless ? "full" : "allowlist", "always", headless ? "full" : "allowlist");
      useTimeout();
      const result = await run({
        command: headless ? "bun ./script.ts" : command,
        security: headless ? "full" : "allowlist",
        ask: "always",
        ...(headless ? { trigger: "cron" as const } : {}),
      });
      expect(result.details?.status).toBe("completed");
      await vi.waitFor(() => {
        expect(requireRunParams(requireGatewayCommand("system.run")).approvalSource).toBe(
          "ask-fallback",
        );
      });
      const runParams = requireRunParams(requireGatewayCommand("system.run"));
      expect(runParams.approved).toBeUndefined();
      expect(runParams.approvalDecision).toBeUndefined();
      if (exact) {
        expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(3);
      }
    },
  );

  it.each([false, true])(
    "denies revoked node-host policy (headless timeout=%s)",
    async (headless) => {
      resolveExecHostApprovalContextMock
        .mockReturnValueOnce(
          createHostPolicy("full", headless ? "always" : "off", headless ? "full" : "deny"),
        )
        .mockImplementationOnce(() => {
          throw new Error("exec denied: host=node security=deny");
        });
      if (headless) {
        inlineApproval.enabled = true;
        useTimeout();
      }
      await expect(run(headless ? { ask: "always", trigger: "cron" } : {})).rejects.toThrow(
        headless ? "denied" : "security=deny",
      );
      expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
      expectNoSystemRun();
    },
  );

  it.each([
    { phase: "timeout policy", checkpoints: 2, reason: "approval-timeout: policy-unavailable" },
    { phase: "timeout dispatch", checkpoints: 3, reason: "invoke-failed" },
  ])("does not dispatch after revocation during $phase", async ({ checkpoints, reason }) => {
    const policy = createHostPolicy("full", "always", "full");
    resolveExecHostApprovalContextMock.mockReset();
    for (let index = 1; index < checkpoints; index += 1) {
      resolveExecHostApprovalContextMock.mockReturnValueOnce(policy);
    }
    resolveExecHostApprovalContextMock.mockImplementationOnce(() => {
      throw new Error("exec denied: host=node security=deny");
    });
    useTimeout();

    const result = await run({ approvalFollowupMode: "agent", ask: "always" });
    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        `Exec denied (node=node-1 id=approval-1, ${reason}): bun ./script.ts`,
      );
    });
    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(checkpoints);
    expectNoSystemRun();
  });

  it.each([{ mode: "direct", direct: true }] as const)(
    "keeps multiline $mode node approval follow-up output intact",
    async ({ mode, direct }) => {
      setHostPolicy("full", "always");
      const stdout = "first line\r\n\tindented\n\nlast line  \t\n";
      const stderr = "warning: something\n";
      callGatewayToolMock.mockImplementation(
        createNodeGatewayHandler({ approvals: { version: 1, agents: {} }, stdout, stderr }),
      );

      const result = await run({ approvalFollowupMode: mode });

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalled();
      });
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ direct }),
        expect.any(String),
      );
      const message = sendExecApprovalFollowupResultMock.mock.calls[0]?.[1];
      if (typeof message !== "string") {
        throw new Error("expected follow-up message");
      }
      expect(message).toContain(`[stdout]\n${stdout}`);
      expect(message).toContain(`[stderr]\n${stderr}`);
      // The compact notify formatter would have collapsed every run of whitespace.
      expect(message).not.toContain("first line indented last line");
    },
  );

  it("returns the reviewer denial to the agent without requesting approval or dispatching", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "deny",
      risk: "medium",
      rationale: "Inspect the script before running it",
    }));
    setHostPolicy("allowlist", "on-miss", "full");
    requiresExecApprovalMock.mockReturnValue(true);

    const result = await runReviewed({
      toolCallId: "denied-node-command",
      autoReviewer,
    });

    const text =
      "Exec denied by auto-review (risk=medium): Inspect the script before running it\n" +
      "Do not attempt the same outcome through a workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or ask the user to approve this exact command after explaining the risk.\n" +
      "Command: /usr/local/bin/bun ./script.ts";
    expect(autoReviewer).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      content: [{ type: "text", text }],
      details: {
        status: "failed",
        exitCode: null,
        failureKind: "auto-review-denied",
        durationMs: 0,
        aggregated: text,
        timedOut: false,
        cwd: "/tmp/work",
        approvalReviewOutcome: "denied",
        approvalReviews: [
          {
            id: "guardian:denied-node-command",
            label: "Guardian",
            status: "denied",
            riskLevel: "medium",
            rationale: "Inspect the script before running it",
          },
        ],
      },
    });
    expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
    expect(
      callGatewayToolMock.mock.calls
        .filter(([method]) => method === "node.invoke")
        .map((call) => call[2]),
    ).not.toContainEqual(expect.objectContaining({ command: "system.run" }));
  });

  it("does not invoke the node after cancellation wins during auto-review", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(() => new Promise(() => {}));
    setHostPolicy("allowlist", "on-miss");
    useUnsatisfiedApprovalRequirement();
    const abortController = new AbortController();
    const result = runReviewed({
      autoReviewer,
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(autoReviewer).toHaveBeenCalledTimes(1));
    const gatewayCallsBeforeResolution = callGatewayToolMock.mock.calls.length;

    abortController.abort(new Error("cancelled during review"));

    await expect(result).rejects.toThrow("cancelled during review");
    expect(callGatewayToolMock.mock.calls).toHaveLength(gatewayCallsBeforeResolution);
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
  });

  it("requests human approval when the node reviewer rejects", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => {
      throw new Error("provider\n\u001b[31mfailed\u001b[0m\u202e");
    });
    const warnings: string[] = [];
    resolveExecApprovalWaitOutcomeMock.mockResolvedValue(
      approvedOutcome("deny", { approvedByAsk: false, deniedReason: null }),
    );
    setHostPolicy("allowlist", "on-miss");

    const result = runReviewed({
      autoReviewer,
      warnings,
    });

    await expect(result).rejects.toThrow("exec denied: approval-required");
    expect(autoReviewer).toHaveBeenCalledTimes(1);
    expect(createExecApprovalRequestRouteMock).toHaveBeenCalledTimes(1);
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-1", host: "node" }),
    );
    expect(callGatewayToolMock.mock.calls).not.toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          "node.invoke",
          expect.anything(),
          expect.objectContaining({ command: "system.run" }),
        ]),
      ]),
    );
    expect(warnings).toEqual([
      "Exec auto-review deferred to human approval (risk=unknown): exec reviewer failed: provider\\nfailed",
    ]);
  });

  it("reviews the prepared node plan before suppressing human approval", async () => {
    const divergentPlan = nodePlan(
      ["/bin/rm", "-rf", "/tmp/work"],
      "/bin/rm -rf /tmp/work",
      "./scripts/check_mail.sh --limit 5",
    );
    preparePlan(divergentPlan);
    const nodeAllowlist = [{ pattern: "./scripts/check_mail.sh" }];
    setNodeApprovals(nodeAllowlist, fullNodePolicy);
    evaluateShellAllowlistMock.mockImplementation(
      (params?: { command?: string; allowlist?: unknown[] }) => {
        const command = params?.command ?? "";
        const hasNodeAllowlist = Array.isArray(params?.allowlist) && params.allowlist.length > 0;
        const previewMatch = command === "./scripts/check_mail.sh --limit 5";
        return {
          allowlistMatches: previewMatch && hasNodeAllowlist ? [{}] : [],
          analysisOk: true,
          allowlistSatisfied: previewMatch && hasNodeAllowlist,
          segments: [
            previewMatch
              ? segment(
                  ["./scripts/check_mail.sh", "--limit", "5"],
                  "./scripts/check_mail.sh --limit 5",
                )
              : segment(["/bin/rm", "-rf", "/tmp/work"], "/bin/rm -rf /tmp/work"),
          ],
          segmentAllowlistEntries: previewMatch && hasNodeAllowlist ? [{}] : [],
        };
      },
    );
    const autoReviewer = vi.fn<ExecAutoReviewer>(async (input) =>
      input.command.includes("rm -rf")
        ? {
            decision: "ask",
            risk: "high",
            rationale: "destructive prepared plan",
          }
        : {
            decision: "allow-once",
            risk: "low",
            rationale: "safe requested text",
          },
    );
    setHostPolicy("allowlist", "on-miss");
    useUnsatisfiedApprovalRequirement();

    const result = await runReviewed({
      command: "echo SAFE",
      autoReviewer,
    });

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/bin/rm -rf /tmp/work",
        argv: ["/bin/rm", "-rf", "/tmp/work"],
        agent: {
          id: "prepared-agent",
          sessionKey: "prepared-session",
        },
      }),
    );
    expect(createExecApprovalRequestRouteMock).toHaveBeenCalled();
    expect(callGatewayToolMock).not.toHaveBeenCalledWith(
      "exec.approval.resolve",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not let transport wrapper allowlist matches approve shell payloads", async () => {
    const wrapperPlan = nodePlan(
      ["/bin/sh", "-lc", "./scripts/untrusted.sh"],
      `/bin/sh -lc "./scripts/untrusted.sh"`,
      "./scripts/untrusted.sh",
    );
    preparePlan(wrapperPlan);
    const nodeAllowlist = [{ pattern: "/bin/sh" }];
    setNodeApprovals(nodeAllowlist, fullNodePolicy);
    evaluateShellAllowlistMock.mockImplementation(
      (params?: { command?: string; allowlist?: unknown[] }) => {
        const command = params?.command ?? "";
        const hasNodeAllowlist = Array.isArray(params?.allowlist) && params.allowlist.length > 0;
        const wrapperMatch = command.startsWith("/bin/sh") && hasNodeAllowlist;
        return {
          allowlistMatches: wrapperMatch ? [{}] : [],
          analysisOk: true,
          allowlistSatisfied: wrapperMatch,
          segments: [
            command.startsWith("/bin/sh")
              ? segment(
                  ["/bin/sh", "-lc", "./scripts/untrusted.sh"],
                  `/bin/sh -lc "./scripts/untrusted.sh"`,
                )
              : segment(["./scripts/untrusted.sh"], "./scripts/untrusted.sh"),
          ],
          segmentAllowlistEntries: wrapperMatch ? [{}] : [],
        };
      },
    );
    useUnsatisfiedApprovalRequirement();
    hasDurableExecApprovalMock.mockImplementation(
      (params?: { segmentAllowlistEntries?: unknown[] }) =>
        Array.isArray(params?.segmentAllowlistEntries) && params.segmentAllowlistEntries.length > 0,
    );
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "ask",
      risk: "medium",
      rationale: "inner payload is not allowlisted",
    }));
    setHostPolicy("allowlist", "on-miss");

    const result = await runReviewed({
      command: "./scripts/untrusted.sh",
      autoReviewer,
    });

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createExecApprovalRequestRouteMock).toHaveBeenCalled();
  });

  it.each([["zsh", "-ic"]])(
    "keeps non-transport %s %s startup shells outside model auto-review",
    async (shell, flag) => {
      const payload = "./scripts/check_mail.sh --limit 5";
      const loginCommand = `${shell} ${flag} "${payload}"`;
      const loginPlan = nodePlan(
        ["/bin/sh", "-lc", loginCommand],
        `/bin/sh -lc "${loginCommand.replaceAll('"', '\\"')}"`,
        loginCommand,
      );
      preparePlan(loginPlan);
      setNodeApprovals([], fullNodePolicy);
      evaluateShellAllowlistMock.mockImplementation((params?: { command?: string }) => {
        const command = params?.command ?? "";
        return analysis([
          command === loginPlan.commandText
            ? segment(["/bin/sh", "-lc", loginCommand], loginPlan.commandText)
            : command === loginCommand
              ? segment([shell, flag, payload], loginCommand)
              : segment(["./scripts/check_mail.sh", "--limit", "5"], payload),
        ]);
      });
      requiresExecApprovalMock.mockImplementation(
        (params?: { allowlistSatisfied?: boolean; durableApprovalSatisfied?: boolean }) =>
          params?.allowlistSatisfied !== true && params?.durableApprovalSatisfied !== true,
      );
      const autoReviewer = allowReviewer();
      setHostPolicy("allowlist", "on-miss");

      const warnings: string[] = [];
      const result = await runReviewed({
        command: loginCommand,
        autoReviewer,
        warnings,
      });

      expect(result.details?.status).toBe("completed");
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(createExecApprovalRequestRouteMock).toHaveBeenCalled();
      expect(warnings).toContain(
        "Exec auto-review skipped: login or interactive shell startup requires human approval",
      );
    },
  );

  it.each([
    {
      name: "deny security",
      nodeSecurity: "deny",
      nodeAsk: "off",
    },
  ] as const)("preserves node policy with a $name floor", async ({ nodeSecurity, nodeAsk }) => {
    const autoReviewer = allowReviewer();
    setHostPolicy("allowlist", "on-miss");
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: preparedPlan,
      execPolicy: { security: nodeSecurity, ask: nodeAsk },
    });
    setNodeApprovals([], {
      security: nodeSecurity,
      ask: nodeAsk,
      askFallback: "deny",
      autoAllowSkills: false,
    });
    callGatewayToolMock.mockImplementation(
      createNodeGatewayHandler({
        approvals: { version: 1, agents: {} },
        allowApprovalResolve: true,
        execPolicy: { security: nodeSecurity, ask: nodeAsk },
      }),
    );

    const execution = runReviewed({
      autoReviewer,
    });

    await expect(execution).rejects.toThrow("security=deny");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
  });

  it.each(["unavailable node policy", "unparseable command"])(
    "does not use fallback-full with %s",
    async (reason) => {
      if (reason === "unavailable node policy") {
        parsePreparedSystemRunPayloadMock.mockReturnValue({
          plan: nodePlan(preparedPlan.argv, preparedPlan.commandText, preparedPlan.commandPreview),
          execPolicy: { security: "full", ask: "off" },
        });
        callGatewayToolMock.mockImplementation(
          createNodeGatewayHandler({
            approvals: new Error("node approvals unavailable"),
            stdout: "should-not-run",
          }),
        );
      } else {
        evaluateShellAllowlistMock.mockReturnValue(analysis([], { analysisOk: false }));
      }
      const autoReviewer = allowReviewer();
      setHostPolicy("allowlist", "on-miss", "full");
      useTimeout("human");
      const result = run({
        ...(reason === "unparseable command" ? { command: "echo 'unterminated" } : {}),
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      });
      await expect(result).rejects.toThrow("exec denied: approval-timeout");
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
      expectNoSystemRun();
    },
  );

  it("requests detached human approval when node runtime policy requires ask always", async () => {
    const autoReviewer = allowReviewer();
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: preparedPlan,
      execPolicy: { security: "full", ask: "always" },
    });
    setNodeApprovals([], fullNodePolicy);
    setHostPolicy("allowlist", "on-miss");

    const result = await runReviewed({
      approvalFollowupMode: "agent",
      autoReviewer,
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createExecApprovalRequestRouteMock).toHaveBeenCalledTimes(1);
    expect(resolveExecApprovalAllowedDecisionsMock).toHaveBeenCalledWith({
      ask: "always",
      allowAlwaysPersistence: {
        kind: "patterns",
        patterns: [{ pattern: "/trusted/bin/tool" }],
      },
    });
    expect(requireRegisteredApprovalRequest().unavailableDecisions).toEqual(["allow-always"]);
    expect(buildExecApprovalPendingToolResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDecisions: ["allow-once", "deny"],
      }),
    );
  });

  it("omits allow-always from node approval prompts when node runtime policy is missing", async () => {
    const autoReviewer = allowReviewer();
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: preparedPlan,
      execPolicy: undefined,
    });
    setHostPolicy("allowlist", "on-miss");

    const result = await runReviewed({
      autoReviewer,
    });

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(resolveExecApprovalAllowedDecisionsMock).toHaveBeenCalledWith({
      ask: "always",
      allowAlwaysPersistence: {
        kind: "patterns",
        patterns: [{ pattern: "/trusted/bin/tool" }],
      },
    });
    expect(requireRegisteredApprovalRequest().unavailableDecisions).toEqual(["allow-always"]);
  });

  it.each([
    {
      name: "asks for human approval",
      decision: { decision: "ask", risk: "medium", rationale: "needs a person" },
    },
    {
      name: "returns a non-low allow decision",
      decision: { decision: "allow-once", risk: "high", rationale: "risk too high" },
    },
  ] as const)("does not use fallback-full when node auto-review $name", async ({ decision }) => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => {
      // Exercise the runtime boundary against a contradictory custom reviewer response.
      return decision as unknown as ExecAutoReviewDecision;
    });
    setHostPolicy("allowlist", "on-miss", "full");
    useTimeout("human");

    const warnings: string[] = [];
    const result = runReviewed({
      autoReviewer,
      warnings,
    });

    await expect(result).rejects.toThrow("exec denied: approval-timeout");
    expect(warnings.join("\n")).toContain(decision.rationale);
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
    expectNoSystemRun();
  });

  it("rejects approval when the node omits prepare", async () => {
    listNodesMock.mockResolvedValueOnce([
      {
        nodeId: "node-1",
        commands: ["system.run", "system.which", "system.notify"],
        connected: true,
        platform: "darwin",
      },
    ]);
    setHostPolicy("full", "always");

    await expect(run({})).rejects.toThrow("node approval requires system.run.prepare support");
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
  });

  it("requires approval when node allowlist matching would depend on gateway PATH", async () => {
    const allowlistEntry = { pattern: "/trusted/bin/tool" };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    setNodeApprovals([allowlistEntry]);
    evaluateShellAllowlistMock.mockImplementation((raw: unknown) => {
      const params = raw as ShellAllowlistMockParams;
      const hasNodeAllowlist = (params.allowlist ?? []).length > 0;
      const gatewayPathWouldMatch = params.env?.PATH?.includes("/trusted/bin") === true;
      return buildAllowlistEvalResult({
        allowlistSatisfied: hasNodeAllowlist && gatewayPathWouldMatch,
        segmentAllowlistEntry: allowlistEntry,
      });
    });
    setHostPolicy("allowlist", "on-miss");
    resolveExecApprovalWaitOutcomeMock.mockResolvedValue({ kind: "request-failed" });

    const result = run({
      command: "tool --version",
      env: { PATH: "/trusted/bin:/usr/bin" },
      security: "allowlist",
      ask: "on-miss",
    });

    await expect(result).rejects.toThrow("exec denied: request-failed");
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledTimes(1);
    expect(requireRegisteredApprovalRequest().env).toBeUndefined();
    const evalEnvs = evaluateShellAllowlistMock.mock.calls.map(
      ([raw]) => (raw as ShellAllowlistMockParams).env,
    );
    expect(evalEnvs.length).toBeGreaterThanOrEqual(2);
    expect(evalEnvs.every((env) => env?.PATH === "" && env?.Path === "")).toBe(true);
    await vi.waitFor(() => {
      expect(resolveExecApprovalWaitOutcomeMock).toHaveBeenCalledTimes(1);
    });
  });

  it("reuses exact node allow-always command entries for prechecks", async () => {
    const allowlistEntry = {
      pattern: "/trusted/bin/tool",
      source: "allow-always" as const,
    };
    const commandMarker = { pattern: nodeCommandMarker, source: "allow-always" as const };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: {
        ...preparedPlan,
        policySnapshot: {
          ...preparedPlan.policySnapshot,
          allowlistRules: [commandMarker, allowlistEntry],
        },
      },
      execPolicy: { security: "full", ask: "off" },
    });
    setNodeApprovals([commandMarker, allowlistEntry]);
    evaluateShellAllowlistMock.mockImplementation((raw: unknown) => {
      const params = raw as ShellAllowlistMockParams;
      expect(params.env?.PATH).toBe("");
      expect(params.env?.Path).toBe("");
      return analysis([segment(["/trusted/bin/tool", "--version"])], {
        segmentAllowlistEntries: [null],
      });
    });
    resolveAllowAlwaysPatternCoverageMock.mockImplementation((raw: unknown) => {
      const params = raw as { segments?: MockAllowlistSegment[]; env?: NodeJS.ProcessEnv };
      expect(params.env?.PATH).toBe("");
      expect(params.env?.Path).toBe("");
      expect(params.segments?.[0]?.argv[0]).toBe("/trusted/bin/tool");
      return {
        complete: true,
        patterns: [{ pattern: "/trusted/bin/tool" }],
      };
    });
    setHostPolicy("allowlist", "on-miss");

    const result = await run({
      command: "/trusted/bin/tool --version",
      env: { PATH: "/gateway/bin:/usr/bin" },
      security: "allowlist",
      ask: "on-miss",
    });

    expect(result.details?.status).toBe("completed");
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
    expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        analysisOk: true,
        allowlistSatisfied: false,
        durableApprovalSatisfied: true,
      }),
    );
    expect(requireRunParams(requireGatewayCommand("system.run")).env).toBeUndefined();
  });

  it.each([undefined, "agent"] as const)(
    "keeps one-shot node grants one-shot with %s follow-up mode",
    async (approvalFollowupMode) => {
      resolveAllowAlwaysPersistenceDecisionMock.mockReturnValue({
        kind: "one-shot",
        reasons: ["no-reusable-pattern"],
      });
      setHostPolicy("allowlist", "on-miss");
      resolveExecApprovalWaitOutcomeMock.mockResolvedValue(approvedOutcome("allow-always"));

      await run({
        security: "allowlist",
        ask: "on-miss",
        approvalFollowupMode,
      });

      await vi.waitFor(() => {
        expect(requireRunParams(requireGatewayCommand("system.run")).approvalDecision).toBe(
          "allow-once",
        );
      });
    },
  );

  it.each([
    {
      name: "partially matching compound command",
      command: "foo && bar",
      patterns: ["/trusted/bin/foo"],
      segments: [segment(["foo"]), segment(["bar"])],
      coverage: {
        complete: true,
        patterns: [{ pattern: "/trusted/bin/foo" }, { pattern: "/trusted/bin/bar" }],
      },
    },
    {
      name: "unrepresentable segment",
      command: 'sh -c "/bin/echo ok && /bin/date" && missingcmd',
      patterns: ["/bin/echo", "/bin/date"],
      segments: [segment(["sh", "-c", "/bin/echo ok && /bin/date"]), segment(["missingcmd"])],
      coverage: { complete: false, patterns: [{ pattern: "/bin/echo" }, { pattern: "/bin/date" }] },
    },
  ])(
    "does not reuse node allow-always metadata for $name",
    async ({ command, patterns, segments, coverage }) => {
      const commandMarker = { pattern: nodeCommandMarker, source: "allow-always" as const };
      mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
      setNodeApprovals([
        commandMarker,
        ...patterns.map((pattern) => ({ pattern, source: "allow-always" as const })),
      ]);
      evaluateShellAllowlistMock.mockReturnValue(
        analysis(segments, { segmentAllowlistEntries: [null, null] }),
      );
      resolveAllowAlwaysPatternCoverageMock.mockReturnValue(coverage);
      setHostPolicy("allowlist", "on-miss");
      resolveExecApprovalWaitOutcomeMock.mockResolvedValue({ kind: "request-failed" });

      await expect(
        run({
          command,
          security: "allowlist",
          ask: "on-miss",
        }),
      ).rejects.toThrow("exec denied: request-failed");
      expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledTimes(1);
      expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowlistSatisfied: false, durableApprovalSatisfied: false }),
      );
    },
  );

  it("uses forwarded node env overrides for node approval prechecks", async () => {
    const allowlistEntry = { pattern: "/trusted/bin/tool" };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    setNodeApprovals([allowlistEntry]);
    evaluateShellAllowlistMock.mockImplementation((raw: unknown) => {
      const params = raw as ShellAllowlistMockParams;
      const hasNodeAllowlist = (params.allowlist ?? []).length > 0;
      return buildAllowlistEvalResult({
        allowlistSatisfied:
          hasNodeAllowlist &&
          params.env != null &&
          params.env.FOO === "bar" &&
          params.env.PATH === "",
        segmentAllowlistEntry: allowlistEntry,
      });
    });
    setHostPolicy("allowlist", "on-miss");

    const result = await run({
      command: "tool --version",
      env: { PATH: "/gateway/bin:/usr/bin" },
      requestedEnv: { FOO: "bar" },
      security: "allowlist",
      ask: "on-miss",
    });

    expect(result.details?.status).toBe("completed");
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
    expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        analysisOk: true,
        allowlistSatisfied: true,
        durableApprovalSatisfied: false,
      }),
    );
    expect(requireGatewayCommand("system.run.prepare").params?.params?.env).toEqual({
      FOO: "bar",
    });
    expect(requireGatewayCommand("system.run.prepare").params?.params?.cwd).toBe("/tmp/work");
    const runParams = requireRunParams(requireGatewayCommand("system.run"));
    expect(runParams.env).toEqual({ FOO: "bar" });
    expect(runParams.cwd).toBe("/tmp/work");
    const evalEnvs = evaluateShellAllowlistMock.mock.calls.map(
      ([raw]) => (raw as ShellAllowlistMockParams).env,
    );
    expect(evalEnvs.length).toBeGreaterThanOrEqual(2);
    expect(evalEnvs.every((env) => env != null && env.FOO === "bar" && env.PATH === "")).toBe(true);
  });

  it("bypasses host approval floors for an explicit full session", async () => {
    await run({ bypassHostApprovalFloors: true });

    expect(resolveExecHostApprovalContextMock).not.toHaveBeenCalled();
    expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    expect(requireRunParams(requireGatewayCommand("system.run")).systemRunPlan).toEqual(
      preparedPlan,
    );
  });

  it("uses the prepared cwd when no workdir was requested", async () => {
    await run({
      workdir: undefined,
    });

    const runParams = requireRunParams(requireGatewayCommand("system.run"));
    expect(runParams.cwd).toBe(preparedPlan.cwd);
  });

  it("rejects disconnected node targets before invoking system.run", async () => {
    listNodesMock.mockResolvedValueOnce([
      {
        nodeId: "node-1",
        commands: ["system.run", "system.run.prepare"],
        connected: false,
        platform: process.platform,
      },
    ]);

    await expect(
      run({
        command: "git log --oneline -5",
        security: "allowlist",
        requestedNode: "node-1",
      }),
    ).rejects.toThrow(
      "exec host=node requires a connected node that supports system.run (node-1 is not eligible; eligible node ids: none)",
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("returns a non-empty placeholder for silent node exec results", async () => {
    callGatewayToolMock.mockImplementation(
      async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
        if (method === "node.invoke" && params?.command === "system.run") {
          return {
            payload: {
              success: true,
              stdout: "",
              stderr: "",
              exitCode: 0,
              timedOut: false,
            },
          };
        }
        return createNodeGatewayHandler({ approvals: { version: 1, agents: {} } })(
          method,
          _options,
          params,
        );
      },
    );

    const result = await run({
      command: "mkdir /tmp/quiet",
    });

    expect(result.content).toEqual([{ type: "text", text: "Node: node-1\n(no output)" }]);
    const details = result.details;
    expect(details?.status).toBe("completed");
    if (details?.status !== "completed") {
      throw new Error(`expected completed details, got ${details?.status ?? "missing"}`);
    }
    expect(details.exitCode).toBe(0);
    expect(details.aggregated).toBe("");
    expect(details.cwd).toBe("/tmp/work");
  });

  it.each([
    {
      timeoutSec: Number.POSITIVE_INFINITY,
      invokeDeadlineMs: 35_000,
      invokeWaitMs: 40_000,
      runTimeoutMs: 30_000,
    },
    {
      timeoutSec: 3_000_000,
      invokeDeadlineMs: MAX_SAFE_TIMEOUT_DELAY_MS,
      invokeWaitMs: MAX_SAFE_TIMEOUT_DELAY_MS,
      runTimeoutMs: MAX_SAFE_TIMEOUT_DELAY_MS,
    },
    {
      timeoutSec: Number.MAX_VALUE,
      invokeDeadlineMs: MAX_SAFE_TIMEOUT_DELAY_MS,
      invokeWaitMs: MAX_SAFE_TIMEOUT_DELAY_MS,
      runTimeoutMs: MAX_SAFE_TIMEOUT_DELAY_MS,
    },
    { timeoutSec: 0, invokeDeadlineMs: 35_000, invokeWaitMs: 40_000, runTimeoutMs: 0 },
    { timeoutSec: 120, invokeDeadlineMs: 125_000, invokeWaitMs: 130_000, runTimeoutMs: 120_000 },
  ])(
    "bounds invocation deadlines for timeoutSec=$timeoutSec",
    async ({ timeoutSec, ...budgets }) => {
      await run({ timeoutSec });
      expectSystemRunInvoke(budgets);
      const prepare = requireGatewayCommand("system.run.prepare");
      expect(prepare.params?.timeoutMs).toBeUndefined();
      expect(prepare.options.timeoutMs).toBe(15_000);
    },
  );

  it.each([
    {
      requestedNode: "other-node",
      boundNode: "f2396b588d391d30a79d300e196a17cf197f34969b5e2485d2734c953567f44e",
      error: "exec node not allowed (bound to f2396b588d391d30",
    },
    {
      requestedNode: "nonexistent-node",
      boundNode: undefined,
      error:
        "requested node not found: nonexistent-node (unknown node: nonexistent-node (known: home-wsl-debian))",
    },
  ])(
    "rejects requested target $requestedNode without dispatch",
    async ({ requestedNode, boundNode, error }) => {
      const homeNode = {
        nodeId: "f2396b588d391d30a79d300e196a17cf197f34969b5e2485d2734c953567f44e",
        displayName: "home-wsl-debian",
        commands: ["system.run", "system.run.prepare"],
        connected: true,
        platform: process.platform,
      };
      listNodesMock.mockResolvedValue([
        homeNode,
        ...(boundNode
          ? [
              {
                ...homeNode,
                nodeId: "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaa7777bbb88889999",
                displayName: "other-node",
              },
            ]
          : []),
      ]);
      await expect(
        run({
          command: "echo hello",
          agentId: "test-agent",
          sessionKey: "test-session",
          boundNode,
          requestedNode,
        }),
      ).rejects.toThrow(error);
      expect(callGatewayToolMock).not.toHaveBeenCalled();
    },
  );

  it("auto-reviews strict inline-eval commands with full/off host policy when node policy is available", async () => {
    const inlinePlan = {
      argv: ["/usr/bin/python3", "-c", "print(1)"],
      cwd: "/tmp/work",
      commandText: "/usr/bin/python3 -c 'print(1)'",
      commandPreview: null,
      agentId: "requested-agent",
      sessionKey: "requested-session",
    };
    preparePlan(inlinePlan);
    const autoReviewer = allowReviewer();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    evaluateShellAllowlistMock.mockReturnValue(
      analysis([segment(["/usr/bin/python3", "-c", "print(1)"], "/usr/bin/python3 -c 'print(1)'")]),
    );
    setHostPolicy("full", "off");

    const result = await run({
      command: "python3 -c 'print(1)'",
      autoReview: true,
      autoReviewer,
      strictInlineEval: true,
    });

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/usr/bin/python3 -c 'print(1)'",
        argv: ["/usr/bin/python3", "-c", "print(1)"],
        host: "node",
        reason: "strict-inline-eval",
      }),
    );
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "exec.approvals.node.get",
      { timeoutMs: 10_000 },
      { nodeId: "node-1" },
    );
  });

  it("denies timed-out inline-eval requests instead of invoking the node", async () => {
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    useTimeout("inline");
    setHostPolicy("full", "off", "full");

    const result = run({
      command: "python3 -c 'print(1)'",
      strictInlineEval: true,
    });

    await expect(result).rejects.toThrow("exec denied: approval-timeout");
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
