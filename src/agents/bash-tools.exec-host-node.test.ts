import crypto from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../packages/gateway-client/src/timeouts.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { requiresExecApproval } from "../infra/exec-approvals-policy.js";
import type { ExecAllowlistEntry } from "../infra/exec-approvals.types.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import { captureProcessUnhandledRejections } from "./bash-tools.exec-runtime.test-support.js";

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

const gatewayMock = vi.hoisted(() => vi.fn());
const listNodesMock = vi.hoisted(() => vi.fn());
const preparedMock = vi.hoisted(() => vi.fn());
const allowlistMock = vi.hoisted(() =>
  vi.fn<(_raw?: ShellAllowlistMockParams) => MockAllowlistResult>(),
);
const commandMarkerMock = vi.hoisted(() =>
  vi.fn((raw: unknown): boolean =>
    ((raw as { allowlist?: Array<{ pattern?: string }> }).allowlist ?? []).some(
      (entry) => entry.pattern === "=node-command:test",
    ),
  ),
);
const patternCoverageMock = vi.hoisted(() => vi.fn<(_raw: unknown) => unknown>());
const nodeApprovalsMock = vi.hoisted(() => vi.fn<() => MockExecApprovalsResolved>());
const requiresApprovalMock = vi.hoisted(() =>
  vi.fn<typeof import("../infra/exec-approvals-policy.js").requiresExecApproval>(),
);
const durableApprovalMock = vi.hoisted(() => vi.fn(() => false));
const persistenceMock = vi.hoisted(() =>
  vi.fn<(_raw: MockAllowAlwaysPersistenceInput) => MockAllowAlwaysPersistenceDecision>(),
);
const hostPolicyMock = vi.hoisted(() =>
  vi.fn(() => ({
    approvals: { allowlist: [] as ExecAllowlistEntry[], file: { version: 1, agents: {} } },
    hostSecurity: "full",
    hostAsk: "off",
    askFallback: "deny",
  })),
);
const approvalDecisionMock = vi.hoisted(() =>
  vi.fn<
    typeof import("./bash-tools.exec-approval-request.js").resolveRegisteredExecApprovalDecision
  >(),
);
const pendingResultMock = vi.hoisted(() => vi.fn());
const followupMock = vi.hoisted(() =>
  vi.fn(async (_target: unknown, _resultText: string) => undefined),
);
const registerApprovalMock = vi.hoisted(() =>
  vi.fn<
    typeof import("./bash-tools.exec-approval-request.js").registerExecApprovalRequestForHostOrThrow
  >(),
);
const inlineEvalMock = vi.hoisted(() => vi.fn<() => typeof INLINE_EVAL_HIT | null>());

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  return {
    ...actual,
    countObsoleteGeneratedExecApprovalRules: vi.fn(() => 0),
    evaluateShellAllowlist: allowlistMock,
    evaluateShellAllowlistWithAuthorization: allowlistMock,
    hasDurableExecApproval: durableApprovalMock,
    hasNodeCommandAllowAlwaysMarker: commandMarkerMock,
    requiresExecApproval: requiresApprovalMock,
    resolveAllowAlwaysPersistenceDecision: persistenceMock,
    resolveAllowAlwaysPatternCoverage: patternCoverageMock,
    resolveExecApprovalsFromFile: nodeApprovalsMock,
  };
});

// mock-isolation: classify inline evaluation deterministically for host approval scenarios.
vi.mock("../infra/command-analysis/inline-eval.js", () => ({
  describeInterpreterInlineEval: vi.fn(() => "inline-eval"),
  detectInterpreterInlineEvalArgv: inlineEvalMock,
}));

vi.mock("../infra/node-shell.js", () => ({
  buildNodeShellCommand: vi.fn(() => ["/bin/sh", "-lc", "bun ./script.ts"]),
}));

// mock-isolation: supply fixture node plans instead of parsing remote preparation responses.
vi.mock("../infra/system-run-approval-context.js", () => ({
  parsePreparedSystemRunPayload: preparedMock,
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, default: { ...actual, randomUUID: () => "approval-1" } };
});

vi.mock("../infra/exec-approval-surface.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approval-surface.js")>()),
  resolveExecApprovalInitiatingSurfaceStateAsync: async () => ({
    kind: "enabled",
    channel: "telegram",
    channelLabel: "Telegram",
  }),
}));

vi.mock("./bash-tools.exec-approval-request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-approval-request.js")>()),
  registerExecApprovalRequestForHostOrThrow: registerApprovalMock,
  resolveRegisteredExecApprovalDecision: approvalDecisionMock,
}));

vi.mock("./bash-tools.exec-host-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-host-shared.js")>()),
  resolveExecHostApprovalContext: hostPolicyMock,
  sendExecApprovalFollowupResult: followupMock,
  buildExecApprovalPendingToolResult: pendingResultMock,
}));

vi.mock("./bash-tools.exec-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-runtime.js")>()),
  createApprovalSlug: vi.fn(() => "slug-1"),
}));

// mock-isolation: keep node RPC effects inside the fixture without a live Gateway connection.
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: gatewayMock,
}));

vi.mock("./tools/nodes-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools/nodes-utils.js")>()),
  listNodes: listNodesMock,
}));

vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

function runNode(overrides: Partial<ExecuteNodeHostCommandParams> = {}) {
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
  options: { timeoutMs?: number };
  params?: MockNodeInvokeParams;
  callOptions?: unknown;
};

function requireGatewayCommand(command: string): GatewayToolCall {
  const call = gatewayMock.mock.calls.find(
    ([method, , params]) =>
      method === "node.invoke" && (params as MockNodeInvokeParams | undefined)?.command === command,
  );
  if (!call) {
    throw new Error(`expected gateway command ${command}`);
  }
  const [, options, params, callOptions] = call as [
    string,
    { timeoutMs?: number },
    MockNodeInvokeParams | undefined,
    unknown,
  ];
  return { options, params, callOptions };
}

function requireRunParams(call: GatewayToolCall): Record<string, unknown> {
  const params = call.params?.params;
  if (!params) {
    throw new Error("expected system.run params");
  }

  return params;
}

function getRunParams() {
  return requireRunParams(requireGatewayCommand("system.run"));
}

function expectNoSystemRun() {
  expect(
    gatewayMock.mock.calls.some(
      ([method, , params]) =>
        method === "node.invoke" &&
        (params as MockNodeInvokeParams | undefined)?.command === "system.run",
    ),
  ).toBe(false);
}

function requireRegisteredApprovalRequest(): Record<string, unknown> {
  const firstCall = registerApprovalMock.mock.calls[0];
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

function mockGateway(params: Partial<Parameters<typeof createNodeGatewayHandler>[0]> = {}) {
  gatewayMock.mockImplementation(
    createNodeGatewayHandler({ approvals: { version: 1, agents: {} }, ...params }),
  );
}

function mockSystemRun(run: () => unknown) {
  const handler = gatewayMock.getMockImplementation();
  if (!handler) {
    throw new Error("missing default gateway mock");
  }
  gatewayMock.mockImplementation((method, options, params: MockNodeInvokeParams | undefined) =>
    method === "node.invoke" && params?.command === "system.run"
      ? run()
      : handler(method, options, params),
  );
}

function expectCall(mock: unknown, fields: object) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

function buildAllowlistEvalResult(params?: {
  allowlistSatisfied?: boolean;
  segmentAllowlistEntry?: { pattern: string } | null;
}) {
  const matched = params?.allowlistSatisfied === true;
  const entries = matched && params?.segmentAllowlistEntry ? [params.segmentAllowlistEntry] : [];
  return analysis([segment(["tool", "--version"])], {
    allowlistMatches: entries,
    allowlistSatisfied: matched,
    segmentAllowlistEntries: entries.length ? entries : [null],
    segmentSatisfiedBy: [matched ? "allowlist" : null],
  });
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

function matchAnalysis(matched: boolean, selected: MockAllowlistSegment) {
  const entries = matched ? [{}] : [];
  return analysis([selected], {
    allowlistMatches: entries,
    allowlistSatisfied: matched,
    segmentAllowlistEntries: entries,
  });
}

function nodeInfo(
  overrides: Partial<
    Awaited<ReturnType<typeof import("./tools/nodes-utils.js").listNodes>>[number]
  > = {},
) {
  return {
    nodeId: "node-1",
    commands: ["system.run", "system.run.prepare"],
    connected: true,
    platform: process.platform,
    ...overrides,
  };
}

function nodePlan(
  argv: string[],
  commandText: string,
  commandPreview: string | null = commandText,
) {
  const { cwd, agentId, sessionKey } = preparedPlan;
  return { argv, cwd, commandText, commandPreview, agentId, sessionKey };
}

function createHostPolicy(
  hostSecurity: ExecSecurity,
  hostAsk: ExecAsk,
  askFallback: ExecSecurity = "deny",
): ReturnType<typeof hostPolicyMock> {
  return {
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity,
    hostAsk,
    askFallback,
  };
}

function requireUnmatchedApproval() {
  requiresApprovalMock.mockImplementation(
    (params?: { allowlistSatisfied?: boolean; durableApprovalSatisfied?: boolean }) =>
      params?.allowlistSatisfied !== true && params?.durableApprovalSatisfied !== true,
  );
}

function reviewNode(
  autoReviewer: ExecAutoReviewer,
  overrides: Partial<ExecuteNodeHostCommandParams> = {},
) {
  return runNode({
    security: "allowlist",
    ask: "on-miss",
    autoReview: true,
    autoReviewer,
    ...overrides,
  });
}

function usePlan(
  plan: unknown,
  execPolicy: { security: ExecSecurity; ask: ExecAsk } | undefined = {
    security: "full",
    ask: "off",
  },
) {
  preparedMock.mockReturnValue({ plan, execPolicy });
}

function setHostPolicy(...args: Parameters<typeof createHostPolicy>) {
  hostPolicyMock.mockReturnValue(createHostPolicy(...args));
}

describe("executeNodeHostCommand", () => {
  beforeEach(() => {
    gatewayMock.mockReset();
    mockGateway({ allowApprovalResolve: true });
    listNodesMock.mockReset().mockResolvedValue([nodeInfo()]);
    preparedMock.mockReset();
    usePlan(preparedPlan);

    allowlistMock
      .mockReset()
      .mockReturnValue(analysis([segment(["/usr/local/bin/bun", "./script.ts"])]));
    commandMarkerMock.mockClear();
    patternCoverageMock.mockReset().mockReturnValue({
      complete: true,
      patterns: [{ pattern: "/trusted/bin/tool" }],
    });
    durableApprovalMock.mockReset().mockReturnValue(false);
    nodeApprovalsMock.mockReset().mockReturnValue(createNodeApprovals([], fullNodePolicy));
    requiresApprovalMock.mockReset().mockImplementation(requiresExecApproval);
    persistenceMock.mockReset().mockReturnValue({
      kind: "patterns",
      patterns: [{ pattern: "/trusted/bin/tool" }],
    });
    hostPolicyMock.mockReset();
    setHostPolicy("full", "off");
    registerApprovalMock.mockReset().mockImplementation(async ({ approvalId }) => ({
      id: approvalId,
      expiresAtMs: Date.now() + 60_000,
    }));
    approvalDecisionMock.mockReset().mockResolvedValue("allow-once");
    pendingResultMock.mockReset().mockReturnValue({
      content: [],
      details: { status: "approval-pending" },
    });
    followupMock.mockReset();
    inlineEvalMock.mockReset().mockReturnValue(null);
  });

  it("denies non-interactive approval requests without creating operator events", async () => {
    setHostPolicy("full", "always");
    const result = await runNode({
      ask: "always",
      nonInteractiveApproval: true,
      agentId: "collector",
      sessionKey: "agent:collector:subagent:child",
    });

    expect(result.details).toMatchObject({
      status: "failed",
      failureKind: "approval_required",
    });
    expect(registerApprovalMock).not.toHaveBeenCalled();
  });

  it("consumes rejected detached node approval recovery and fallback follow-ups", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      approvalDecisionMock.mockRejectedValueOnce(new Error("approval request failed"));
      followupMock.mockRejectedValue(new Error("approval failure follow-up unavailable"));
      setHostPolicy("full", "always");

      const result = await runNode({ approvalFollowupMode: "agent" });

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => expect(followupMock).toHaveBeenCalledTimes(2));
      await setImmediate();
      expect(unhandledRejections.reasons).toEqual([]);
      for (const call of [1, 2]) {
        expect(followupMock).toHaveBeenNthCalledWith(
          call,
          expect.objectContaining({ approvalId: "approval-1" }),
          "Exec denied (node=node-1 id=approval-1, approval-request-failed): bun ./script.ts",
        );
      }
      expectNoSystemRun();
    } finally {
      unhandledRejections.restore();
    }
  });

  it("never replaces a detached outcome-unknown result with denial when delivery fails", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      mockSystemRun(async () => {
        throw Object.assign(new Error("node disconnected"), {
          name: "GatewayClientRequestError",
          gatewayCode: "UNAVAILABLE",
          details: {
            nodeError: { code: "DISCONNECTED", message: "node disconnected" },
            nodeCommandDispatched: true,
          },
        });
      });
      followupMock.mockRejectedValueOnce(new Error("outcome-unknown follow-up unavailable"));
      setHostPolicy("full", "always");

      const result = await runNode({ approvalFollowupMode: "agent", ask: "always" });

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => expect(followupMock).toHaveBeenCalled());
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      expect(followupMock).toHaveBeenCalledOnce();
      expect(followupMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        expect.stringContaining(
          "Exec outcome unknown (node=node-1 id=approval-1, outcome-unknown)",
        ),
      );
    } finally {
      unhandledRejections.restore();
    }
  });

  it.each(["decision", "policy", "dispatch"] as const)(
    "drops detached node work cancelled during %s",
    async (stage) => {
      const unhandledRejections = captureProcessUnhandledRejections();
      try {
        const controller = new AbortController();
        const policy = createHostPolicy("full", "always");
        const decision = createDeferred<string | null>();
        const checkpoint = createDeferred<typeof policy>();
        const invocation = createDeferred<{
          payload: { success: boolean; stdout: string; exitCode: number };
        }>();
        setHostPolicy("full", "always");
        if (stage === "decision") {
          approvalDecisionMock.mockReturnValueOnce(decision.promise);
        } else if (stage === "policy") {
          hostPolicyMock
            .mockReturnValueOnce(policy)
            .mockImplementationOnce(
              () => checkpoint.promise as unknown as ReturnType<typeof hostPolicyMock>,
            );
        } else {
          mockGateway();
          mockSystemRun(() => invocation.promise);
        }
        const result = await runNode({ approvalFollowupMode: "agent", signal: controller.signal });
        expect(result.details?.status).toBe("approval-pending");
        if (stage === "decision") {
          expect(approvalDecisionMock).toHaveBeenCalledOnce();
          controller.abort();
          decision.resolve("allow-once");
        } else if (stage === "policy") {
          await vi.waitFor(() => expect(hostPolicyMock).toHaveBeenCalledTimes(2));
          controller.abort();
          checkpoint.resolve(policy);
        } else {
          await vi.waitFor(() =>
            expect(requireGatewayCommand("system.run").callOptions).toEqual({
              scopes: ["operator.write", "operator.approvals"],
              signal: controller.signal,
              dispatchAuthority: {
                version: 2,
                kind: "source-bound",
                assertCurrent: expect.any(Function),
              },
            }),
          );
          controller.abort(new Error("run aborted during node invocation"));
          invocation.reject(controller.signal.reason);
        }
        await setImmediate();
        expect(unhandledRejections.reasons).toEqual([]);
        expect(followupMock).not.toHaveBeenCalled();
        if (stage !== "dispatch") {
          expectNoSystemRun();
        }
        if (stage === "decision") {
          expect(hostPolicyMock).toHaveBeenCalledTimes(1);
        }
      } finally {
        unhandledRejections.restore();
      }
    },
  );

  it("forwards prepared systemRunPlan within the native turn after approval", async () => {
    setHostPolicy("full", "always");

    const result = await runNode({
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
    expect(runParams).toMatchObject({
      approved: true,
      approvalDecision: "allow-once",
      timeoutMs: 30_000,
      turnSourceChannel: "telegram",
      turnSourceTo: "telegram:12345",
      turnSourceAccountId: "work",
      turnSourceThreadId: "42",
    });
    expect(runParams.approvalSource).toBeUndefined();
    expect(runParams.systemRunPlan).toEqual(preparedPlan);
  });

  it("does not dispatch an async human approval after gateway policy revocation", async () => {
    hostPolicyMock
      .mockReturnValueOnce(createHostPolicy("full", "always"))
      .mockReturnValueOnce(createHostPolicy("deny", "always"));

    const result = await runNode({ approvalFollowupMode: "agent" });

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(followupMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        "Exec denied (node=node-1 id=approval-1, invoke-failed): bun ./script.ts",
      );
    });
    expect(hostPolicyMock).toHaveBeenCalledTimes(2);
    expectNoSystemRun();
  });

  it("does not dispatch an auto-reviewed command after gateway policy requires a human", async () => {
    const autoReviewer = allowReviewer();
    hostPolicyMock
      .mockReturnValueOnce(createHostPolicy("allowlist", "on-miss"))
      .mockReturnValueOnce(createHostPolicy("allowlist", "always"));

    await expect(reviewNode(autoReviewer)).rejects.toThrow("ask=always requires human approval");

    expectNoSystemRun();
  });

  it.each(["allowlist", "headless", "durable"] as const)(
    "tags %s timeout fallback without fabricating a human grant",
    async (kind) => {
      const headless = kind === "headless";
      const security = headless ? "full" : "allowlist";
      const command =
        kind === "allowlist"
          ? "tool --version"
          : headless
            ? "bun ./script.ts"
            : preparedPlan.commandText;
      setHostPolicy(security, "always", security);
      approvalDecisionMock.mockResolvedValue(null);
      if (headless) {
        registerApprovalMock.mockResolvedValue({
          id: "approval-1",
          expiresAtMs: Date.now() + 60_000,
          finalDecision: null,
        });
      } else {
        const entry =
          kind === "durable"
            ? {
                pattern: exactCommandMarker(command),
                source: "allow-always" as const,
                commandText: command,
              }
            : { pattern: "/trusted/bin/tool" };
        allowlistMock.mockReturnValue(
          buildAllowlistEvalResult({
            allowlistSatisfied: kind === "allowlist",
            segmentAllowlistEntry: entry,
          }),
        );
        durableApprovalMock.mockReturnValue(kind === "durable");
        nodeApprovalsMock.mockReturnValue(
          createNodeApprovals([entry], {
            ...fullNodePolicy,
            security,
            ask: kind === "durable" ? "always" : "on-miss",
          }),
        );
      }
      const result = await runNode({
        command,
        security,
        ask: "always",
        ...(headless ? { trigger: "cron" } : {}),
      });
      expect(result.details?.status).toBe("completed");
      const runParams = getRunParams();
      expect(runParams.approvalSource).toBe("ask-fallback");
      if (kind !== "durable") {
        expect(runParams.approved).toBeUndefined();
        expect(runParams.approvalDecision).toBeUndefined();
      }
    },
  );

  it.each([false, true])(
    "denies revoked node-host policy (headless timeout=%s)",
    async (headless) => {
      hostPolicyMock
        .mockReturnValueOnce(
          createHostPolicy("full", headless ? "always" : "off", headless ? "full" : "deny"),
        )
        .mockImplementationOnce(() => {
          throw new Error("exec denied: host=node security=deny");
        });
      if (headless) {
        registerApprovalMock.mockResolvedValue({
          id: "approval-1",
          expiresAtMs: Date.now() + 60_000,
          finalDecision: null,
        });
      }
      await expect(runNode(headless ? { ask: "always", trigger: "cron" } : {})).rejects.toThrow(
        headless ? "denied" : "security=deny",
      );
      expect(hostPolicyMock).toHaveBeenCalledTimes(2);
      expectNoSystemRun();
    },
  );

  it.each([
    { phase: "timeout policy", checkpoints: 2, reason: "approval-timeout: policy-unavailable" },
    { phase: "timeout dispatch", checkpoints: 3, reason: "invoke-failed" },
  ])("does not dispatch after revocation during $phase", async ({ checkpoints, reason }) => {
    const policy = createHostPolicy("full", "always", "full");
    hostPolicyMock.mockReset();
    for (let index = 1; index < checkpoints; index += 1) {
      hostPolicyMock.mockReturnValueOnce(policy);
    }
    hostPolicyMock.mockImplementationOnce(() => {
      throw new Error("exec denied: host=node security=deny");
    });
    approvalDecisionMock.mockResolvedValue(null);

    const result = await runNode({ approvalFollowupMode: "agent", ask: "always" });
    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(followupMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        `Exec denied (node=node-1 id=approval-1, ${reason}): bun ./script.ts`,
      );
    });
    expect(hostPolicyMock).toHaveBeenCalledTimes(checkpoints);
    expectNoSystemRun();
  });

  it("keeps multiline direct node approval follow-up output intact", async () => {
    setHostPolicy("full", "always");
    const stdout = "first line\r\n\tindented\n\nlast line  \t\n";
    const stderr = "warning: something\n";
    mockGateway({ stdout, stderr });

    const result = await runNode({ approvalFollowupMode: "direct" });

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => expect(followupMock).toHaveBeenCalled());
    expect(followupMock).toHaveBeenCalledWith(
      expect.objectContaining({ direct: true }),
      expect.any(String),
    );
    const message = followupMock.mock.calls[0]?.[1];
    if (typeof message !== "string") {
      throw new Error("expected follow-up message");
    }
    expect(message).toContain(`[stdout]\n${stdout}`);
    expect(message).toContain(`[stderr]\n${stderr}`);
    // The compact notify formatter would have collapsed every run of whitespace.
    expect(message).not.toContain("first line indented last line");
  });

  it("returns the reviewer denial to the agent without requesting approval or dispatching", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "deny",
      risk: "medium",
      rationale: "Inspect the script before running it",
    }));
    setHostPolicy("allowlist", "on-miss", "full");
    requiresApprovalMock.mockReturnValue(true);

    const result = await reviewNode(autoReviewer, { toolCallId: "denied-node-command" });

    const text =
      "Exec denied by auto-review (risk=medium): Inspect the script before running it\n" +
      "Do not attempt the same outcome through a workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or ask the user to approve this exact command after explaining the risk.\n" +
      "Command: /usr/local/bin/bun ./script.ts";
    expect(result).toMatchObject({
      content: [{ type: "text", text }],
      details: {
        status: "failed",
        failureKind: "auto-review-denied",
        aggregated: text,
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
    expect(registerApprovalMock).not.toHaveBeenCalled();
    expectNoSystemRun();
  });

  it("does not invoke the node after cancellation wins during auto-review", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(() => new Promise(() => {}));
    setHostPolicy("allowlist", "on-miss");
    requireUnmatchedApproval();
    const abortController = new AbortController();
    const result = reviewNode(autoReviewer, { signal: abortController.signal });
    await vi.waitFor(() => expect(autoReviewer).toHaveBeenCalledTimes(1));
    const gatewayCallsBeforeResolution = gatewayMock.mock.calls.length;

    abortController.abort(new Error("cancelled during review"));

    await expect(result).rejects.toThrow("cancelled during review");
    expect(gatewayMock.mock.calls).toHaveLength(gatewayCallsBeforeResolution);
    expect(registerApprovalMock).not.toHaveBeenCalled();
  });

  it("requests human approval when the node reviewer rejects", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => {
      throw new Error("provider\n\u001b[31mfailed\u001b[0m\u202e");
    });
    const warnings: string[] = [];
    approvalDecisionMock.mockResolvedValue("deny");
    setHostPolicy("allowlist", "on-miss");

    const result = reviewNode(autoReviewer, { warnings });

    await expect(result).rejects.toThrow("exec denied: user-denied");
    expectCall(registerApprovalMock, { approvalId: "approval-1", host: "node" });
    expectNoSystemRun();
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
    usePlan(divergentPlan);
    const nodeAllowlist = [{ pattern: "./scripts/check_mail.sh" }];
    nodeApprovalsMock.mockReturnValue(createNodeApprovals(nodeAllowlist, fullNodePolicy));
    allowlistMock.mockImplementation((params?: { command?: string; allowlist?: unknown[] }) => {
      const command = params?.command ?? "";
      const hasNodeAllowlist = Array.isArray(params?.allowlist) && params.allowlist.length > 0;
      const previewMatch = command === "./scripts/check_mail.sh --limit 5";
      return matchAnalysis(
        previewMatch && hasNodeAllowlist,
        previewMatch
          ? segment(["./scripts/check_mail.sh", "--limit", "5"], command)
          : segment(divergentPlan.argv, divergentPlan.commandText),
      );
    });
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
    requireUnmatchedApproval();

    const result = await reviewNode(autoReviewer, { command: "echo SAFE" });

    expect(result.details?.status).toBe("completed");
    expectCall(autoReviewer, {
      command: "/bin/rm -rf /tmp/work",
      argv: ["/bin/rm", "-rf", "/tmp/work"],
      agent: {
        id: "prepared-agent",
        sessionKey: "prepared-session",
      },
    });
    expect(registerApprovalMock).toHaveBeenCalled();
    expect(gatewayMock).not.toHaveBeenCalledWith(
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
    usePlan(wrapperPlan);
    const nodeAllowlist = [{ pattern: "/bin/sh" }];
    nodeApprovalsMock.mockReturnValue(createNodeApprovals(nodeAllowlist, fullNodePolicy));
    allowlistMock.mockImplementation((params?: { command?: string; allowlist?: unknown[] }) => {
      const command = params?.command ?? "";
      const hasNodeAllowlist = Array.isArray(params?.allowlist) && params.allowlist.length > 0;
      const wrapperMatch = command.startsWith("/bin/sh") && hasNodeAllowlist;
      return matchAnalysis(
        wrapperMatch,
        command.startsWith("/bin/sh")
          ? segment(wrapperPlan.argv, wrapperPlan.commandText)
          : segment(["./scripts/untrusted.sh"], "./scripts/untrusted.sh"),
      );
    });
    requireUnmatchedApproval();
    durableApprovalMock.mockImplementation(
      (params?: { segmentAllowlistEntries?: unknown[] }) =>
        Array.isArray(params?.segmentAllowlistEntries) && params.segmentAllowlistEntries.length > 0,
    );
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "ask",
      risk: "medium",
      rationale: "inner payload is not allowlisted",
    }));
    setHostPolicy("allowlist", "on-miss");

    const result = await reviewNode(autoReviewer, { command: "./scripts/untrusted.sh" });

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(registerApprovalMock).toHaveBeenCalled();
  });

  it("keeps non-transport zsh -ic startup shells outside model auto-review", async () => {
    const shell = "zsh";
    const flag = "-ic";
    const payload = "./scripts/check_mail.sh --limit 5";
    const loginCommand = `${shell} ${flag} "${payload}"`;
    const loginPlan = nodePlan(
      ["/bin/sh", "-lc", loginCommand],
      `/bin/sh -lc "${loginCommand.replaceAll('"', '\\"')}"`,
      loginCommand,
    );
    usePlan(loginPlan);
    allowlistMock.mockImplementation((params?: { command?: string }) => {
      const command = params?.command ?? "";
      return analysis([
        command === loginPlan.commandText
          ? segment(["/bin/sh", "-lc", loginCommand], loginPlan.commandText)
          : command === loginCommand
            ? segment([shell, flag, payload], loginCommand)
            : segment(["./scripts/check_mail.sh", "--limit", "5"], payload),
      ]);
    });
    requireUnmatchedApproval();
    const autoReviewer = allowReviewer();
    setHostPolicy("allowlist", "on-miss");

    const warnings: string[] = [];
    const result = await reviewNode(autoReviewer, { command: loginCommand, warnings });

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(registerApprovalMock).toHaveBeenCalled();
    expect(warnings).toContain(
      "Exec auto-review skipped: login or interactive shell startup requires human approval",
    );
  });

  it("preserves node policy with a deny security floor", async () => {
    const execPolicy = { security: "deny", ask: "off" } as const;
    const autoReviewer = allowReviewer();
    setHostPolicy("allowlist", "on-miss");
    usePlan(preparedPlan, execPolicy);
    nodeApprovalsMock.mockReturnValue(
      createNodeApprovals([], { ...fullNodePolicy, ...execPolicy }),
    );
    mockGateway({ allowApprovalResolve: true, execPolicy });

    const execution = reviewNode(autoReviewer);

    await expect(execution).rejects.toThrow("security=deny");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(registerApprovalMock).not.toHaveBeenCalled();
  });

  it.each(["unavailable node policy", "unparseable command"])(
    "does not use fallback-full with %s",
    async (reason) => {
      if (reason === "unavailable node policy") {
        preparedMock.mockReturnValue({
          plan: nodePlan(preparedPlan.argv, preparedPlan.commandText, preparedPlan.commandPreview),
          execPolicy: { security: "full", ask: "off" },
        });
        mockGateway({
          approvals: new Error("node approvals unavailable"),
          stdout: "should-not-run",
        });
      } else {
        allowlistMock.mockReturnValue(analysis([], { analysisOk: false }));
      }
      const autoReviewer = allowReviewer();
      setHostPolicy("allowlist", "on-miss", "full");
      approvalDecisionMock.mockResolvedValue(null);
      const result = runNode({
        ...(reason === "unparseable command" ? { command: "echo 'unterminated" } : {}),
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      });
      await expect(result).rejects.toThrow("exec denied: approval-timeout");
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(followupMock).not.toHaveBeenCalled();
      expectNoSystemRun();
    },
  );

  it.each(["ask-always", "missing"] as const)(
    "keeps node runtime policy %s on the one-shot human path",
    async (policy) => {
      const detached = policy === "ask-always";
      const autoReviewer = allowReviewer();
      preparedMock.mockReturnValue({
        plan: preparedPlan,
        execPolicy: detached ? { security: "full", ask: "always" } : undefined,
      });
      setHostPolicy("allowlist", "on-miss");
      const result = await reviewNode(
        autoReviewer,
        detached ? { approvalFollowupMode: "agent" } : {},
      );
      expect(result.details?.status).toBe(detached ? "approval-pending" : "completed");
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(requireRegisteredApprovalRequest().unavailableDecisions).toEqual(["allow-always"]);
      if (detached) {
        expect(registerApprovalMock).toHaveBeenCalledTimes(1);
        expectCall(pendingResultMock, { allowedDecisions: ["allow-once", "deny"] });
      }
    },
  );

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
    approvalDecisionMock.mockResolvedValue(null);

    const warnings: string[] = [];
    const result = reviewNode(autoReviewer, { warnings });

    await expect(result).rejects.toThrow("exec denied: approval-timeout");
    expect(warnings.join("\n")).toContain(decision.rationale);
    expect(followupMock).not.toHaveBeenCalled();
    expectNoSystemRun();
  });

  it("rejects approval when the node omits prepare", async () => {
    listNodesMock.mockResolvedValueOnce([
      nodeInfo({ commands: ["system.run", "system.which", "system.notify"], platform: "darwin" }),
    ]);
    setHostPolicy("full", "always");

    await expect(runNode({})).rejects.toThrow("node approval requires system.run.prepare support");
    expect(registerApprovalMock).not.toHaveBeenCalled();
  });

  it("requires approval when node allowlist matching would depend on gateway PATH", async () => {
    const allowlistEntry = { pattern: "/trusted/bin/tool" };
    mockGateway({ approvals: { version: 1, agents: {} } });
    nodeApprovalsMock.mockReturnValue(createNodeApprovals([allowlistEntry]));
    allowlistMock.mockImplementation((raw: unknown) => {
      const params = raw as ShellAllowlistMockParams;
      const hasNodeAllowlist = (params.allowlist ?? []).length > 0;
      const gatewayPathWouldMatch = params.env?.PATH?.includes("/trusted/bin") === true;
      return buildAllowlistEvalResult({
        allowlistSatisfied: hasNodeAllowlist && gatewayPathWouldMatch,
        segmentAllowlistEntry: allowlistEntry,
      });
    });
    setHostPolicy("allowlist", "on-miss");
    approvalDecisionMock.mockRejectedValue(new Error("approval request failed"));

    const result = runNode({
      command: "tool --version",
      env: { PATH: "/trusted/bin:/usr/bin" },
      security: "allowlist",
      ask: "on-miss",
    });

    await expect(result).rejects.toThrow("exec denied: request-failed");
    expect(registerApprovalMock).toHaveBeenCalledTimes(1);
    expect(requireRegisteredApprovalRequest().env).toBeUndefined();
    const evalEnvs = allowlistMock.mock.calls.map(([raw]) => (raw as ShellAllowlistMockParams).env);
    expect(evalEnvs.length).toBeGreaterThanOrEqual(2);
    expect(evalEnvs.every((env) => env?.PATH === "" && env?.Path === "")).toBe(true);
    await vi.waitFor(() => expect(approvalDecisionMock).toHaveBeenCalledTimes(1));
  });

  it("reuses exact node allow-always command entries for prechecks", async () => {
    const allowlistEntry = {
      pattern: "/trusted/bin/tool",
      source: "allow-always" as const,
    };
    const commandMarker = { pattern: nodeCommandMarker, source: "allow-always" as const };
    mockGateway({ approvals: { version: 1, agents: {} } });
    preparedMock.mockReturnValue({
      plan: {
        ...preparedPlan,
        policySnapshot: {
          ...preparedPlan.policySnapshot,
          allowlistRules: [commandMarker, allowlistEntry],
        },
      },
      execPolicy: { security: "full", ask: "off" },
    });
    nodeApprovalsMock.mockReturnValue(createNodeApprovals([commandMarker, allowlistEntry]));
    allowlistMock.mockReturnValue(
      analysis([segment(["/trusted/bin/tool", "--version"])], {
        segmentAllowlistEntries: [null],
      }),
    );
    patternCoverageMock.mockImplementation((raw: unknown) => {
      const params = raw as { segments?: MockAllowlistSegment[]; env?: NodeJS.ProcessEnv };
      expect(params.segments?.[0]?.argv[0]).toBe("/trusted/bin/tool");
      return {
        complete: true,
        patterns: [{ pattern: "/trusted/bin/tool" }],
      };
    });
    setHostPolicy("allowlist", "on-miss");

    const result = await runNode({
      command: "/trusted/bin/tool --version",
      env: { PATH: "/gateway/bin:/usr/bin" },
      security: "allowlist",
      ask: "on-miss",
    });

    expect(result.details?.status).toBe("completed");
    expect(registerApprovalMock).not.toHaveBeenCalled();
    expect(getRunParams().env).toBeUndefined();
  });

  it.each([undefined, "agent"] as const)(
    "keeps one-shot node grants one-shot with %s follow-up mode",
    async (approvalFollowupMode) => {
      persistenceMock.mockReturnValue({
        kind: "one-shot",
        reasons: ["no-reusable-pattern"],
      });
      setHostPolicy("allowlist", "on-miss");
      approvalDecisionMock.mockResolvedValue("allow-always");

      await runNode({
        security: "allowlist",
        ask: "on-miss",
        approvalFollowupMode,
      });

      await vi.waitFor(() => expect(getRunParams().approvalDecision).toBe("allow-once"));
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
      mockGateway({ approvals: { version: 1, agents: {} } });
      nodeApprovalsMock.mockReturnValue(
        createNodeApprovals([
          commandMarker,
          ...patterns.map((pattern) => ({ pattern, source: "allow-always" as const })),
        ]),
      );
      allowlistMock.mockReturnValue(analysis(segments, { segmentAllowlistEntries: [null, null] }));
      patternCoverageMock.mockReturnValue(coverage);
      setHostPolicy("allowlist", "on-miss");
      approvalDecisionMock.mockRejectedValue(new Error("approval request failed"));

      await expect(
        runNode({
          command,
          security: "allowlist",
          ask: "on-miss",
        }),
      ).rejects.toThrow("exec denied: request-failed");
      expect(registerApprovalMock).toHaveBeenCalledTimes(1);
    },
  );

  it("uses forwarded node env overrides for node approval prechecks", async () => {
    const allowlistEntry = { pattern: "/trusted/bin/tool" };
    mockGateway({ approvals: { version: 1, agents: {} } });
    nodeApprovalsMock.mockReturnValue(createNodeApprovals([allowlistEntry]));
    allowlistMock.mockImplementation((raw: unknown) => {
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

    const result = await runNode({
      command: "tool --version",
      env: { PATH: "/gateway/bin:/usr/bin" },
      requestedEnv: { FOO: "bar" },
      security: "allowlist",
      ask: "on-miss",
    });

    expect(result.details?.status).toBe("completed");
    expect(registerApprovalMock).not.toHaveBeenCalled();
    const preparation = requireGatewayCommand("system.run.prepare").params?.params;
    const runParams = getRunParams();
    for (const params of [preparation, runParams]) {
      expect(params?.env).toEqual({ FOO: "bar" });
      expect(params?.cwd).toBe("/tmp/work");
    }
    const evalEnvs = allowlistMock.mock.calls.map(([raw]) => (raw as ShellAllowlistMockParams).env);
    expect(evalEnvs.length).toBeGreaterThanOrEqual(2);
    expect(evalEnvs.every((env) => env != null && env.FOO === "bar" && env.PATH === "")).toBe(true);
  });

  it("bypasses host approval floors for an explicit full session", async () => {
    await runNode({ bypassHostApprovalFloors: true });

    expect(hostPolicyMock).not.toHaveBeenCalled();
    expect(getRunParams().systemRunPlan).toEqual(preparedPlan);
  });

  it("uses the prepared cwd when no workdir was requested", async () => {
    await runNode({ workdir: undefined });

    expect(getRunParams().cwd).toBe(preparedPlan.cwd);
  });

  it("rejects disconnected node targets before invoking system.run", async () => {
    listNodesMock.mockResolvedValueOnce([nodeInfo({ connected: false })]);

    await expect(
      runNode({
        command: "git log --oneline -5",
        security: "allowlist",
        requestedNode: "node-1",
      }),
    ).rejects.toThrow(
      "exec host=node requires a connected node that supports system.run (node-1 is not eligible; eligible node ids: none)",
    );
    expect(gatewayMock).not.toHaveBeenCalled();
  });

  it("returns a non-empty placeholder for silent node exec results", async () => {
    mockGateway({ stdout: "" });

    const result = await runNode({
      command: "mkdir /tmp/quiet",
    });

    expect(result.content).toEqual([{ type: "text", text: "Node: node-1\n(no output)" }]);
    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregated: "",
      cwd: "/tmp/work",
    });
  });

  it.each([
    [Number.POSITIVE_INFINITY, 35_000, 40_000, 30_000],
    [3_000_000, MAX_SAFE_TIMEOUT_DELAY_MS, MAX_SAFE_TIMEOUT_DELAY_MS, MAX_SAFE_TIMEOUT_DELAY_MS],
    [
      Number.MAX_VALUE,
      MAX_SAFE_TIMEOUT_DELAY_MS,
      MAX_SAFE_TIMEOUT_DELAY_MS,
      MAX_SAFE_TIMEOUT_DELAY_MS,
    ],
    [0, 35_000, 40_000, 0],
    [120, 125_000, 130_000, 120_000],
  ])(
    "bounds invocation deadlines for timeoutSec=%s",
    async (timeoutSec, invokeDeadlineMs, invokeWaitMs, runTimeoutMs) => {
      await runNode({ timeoutSec });
      expectSystemRunInvoke({ invokeDeadlineMs, invokeWaitMs, runTimeoutMs });
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
      const homeNode = nodeInfo({
        nodeId: "f2396b588d391d30a79d300e196a17cf197f34969b5e2485d2734c953567f44e",
        displayName: "home-wsl-debian",
      });
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
        runNode({
          command: "echo hello",
          agentId: "test-agent",
          sessionKey: "test-session",
          boundNode,
          requestedNode,
        }),
      ).rejects.toThrow(error);
      expect(gatewayMock).not.toHaveBeenCalled();
    },
  );

  it("auto-reviews strict inline-eval commands with full/off host policy when node policy is available", async () => {
    const inlinePlan = {
      ...nodePlan(["/usr/bin/python3", "-c", "print(1)"], "/usr/bin/python3 -c 'print(1)'", null),
      agentId: "requested-agent",
      sessionKey: "requested-session",
    };
    usePlan(inlinePlan);
    const autoReviewer = allowReviewer();
    inlineEvalMock.mockReturnValue(INLINE_EVAL_HIT);
    allowlistMock.mockReturnValue(
      analysis([segment(["/usr/bin/python3", "-c", "print(1)"], "/usr/bin/python3 -c 'print(1)'")]),
    );
    setHostPolicy("full", "off");

    const result = await runNode({
      command: "python3 -c 'print(1)'",
      autoReview: true,
      autoReviewer,
      strictInlineEval: true,
    });

    expect(result.details?.status).toBe("completed");
    expectCall(autoReviewer, {
      command: "/usr/bin/python3 -c 'print(1)'",
      argv: ["/usr/bin/python3", "-c", "print(1)"],
      host: "node",
      reason: "strict-inline-eval",
    });
  });

  it("denies timed-out inline-eval requests instead of invoking the node", async () => {
    inlineEvalMock.mockReturnValue(INLINE_EVAL_HIT);
    approvalDecisionMock.mockResolvedValue(null);
    setHostPolicy("full", "off", "full");

    const result = runNode({
      command: "python3 -c 'print(1)'",
      strictInlineEval: true,
    });

    await expect(result).rejects.toThrow("exec denied: approval-timeout");
    expect(followupMock).not.toHaveBeenCalled();
    expect(gatewayMock).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
