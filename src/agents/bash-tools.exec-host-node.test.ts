import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type StrictInlineEvalBoundary =
  typeof import("./bash-tools.exec-host-shared.js").enforceStrictInlineEvalApprovalBoundary;
type ExecAutoReviewer = typeof import("../infra/exec-auto-review.js").defaultExecAutoReviewer;
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
};

const INLINE_EVAL_HIT = {
  executable: "python3",
  normalizedExecutable: "python3",
  flag: "-c",
  argv: ["python3", "-c", "print(1)"],
};

const preparedPlan = vi.hoisted(() => ({
  argv: ["bun", "./script.ts"],
  cwd: "/tmp/work",
  commandText: "bun ./script.ts",
  commandPreview: "bun ./script.ts",
  agentId: "prepared-agent",
  sessionKey: "prepared-session",
  mutableFileOperand: {
    argvIndex: 1,
    path: "/tmp/work/script.ts",
    sha256: "abc123",
  },
}));

const callGatewayToolMock = vi.hoisted(() => vi.fn());
const listNodesMock = vi.hoisted(() => vi.fn());
const parsePreparedSystemRunPayloadMock = vi.hoisted(() => vi.fn());
const commandRequiresSecurityAuditSuppressionApprovalMock = vi.hoisted(() => vi.fn(() => false));
const evaluateShellAllowlistMock = vi.hoisted(() =>
  vi.fn(
    (): MockAllowlistResult => ({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["bun", "./script.ts"] }],
      segmentAllowlistEntries: [],
    }),
  ),
);
const resolveExecApprovalsFromFileMock = vi.hoisted(() =>
  vi.fn(() => ({
    allowlist: [],
    file: { version: 1, agents: {} },
    agent: {
      security: "full",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
  })),
);
const requiresExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity: "full",
    hostAsk: "off",
    askFallback: "deny",
  })),
);
const createAndRegisterDefaultExecApprovalRequestMock = vi.hoisted(() => vi.fn());
const resolveApprovalDecisionOrUndefinedMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null | undefined> => "allow-once"),
);
const createExecApprovalDecisionStateMock = vi.hoisted(() =>
  vi.fn(
    (): {
      baseDecision: { timedOut: boolean };
      approvedByAsk: boolean;
      deniedReason: string | null;
    } => ({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: null,
    }),
  ),
);
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const sendExecApprovalFollowupResultMock = vi.hoisted(() => vi.fn(async () => undefined));
const enforceStrictInlineEvalApprovalBoundaryMock = vi.hoisted(() =>
  vi.fn<StrictInlineEvalBoundary>((value) => ({
    approvedByAsk: value.approvedByAsk,
    deniedReason: value.deniedReason,
  })),
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

vi.mock("../infra/exec-approvals.js", () => ({
  evaluateShellAllowlist: evaluateShellAllowlistMock,
  commandRequiresSecurityAuditSuppressionApproval:
    commandRequiresSecurityAuditSuppressionApprovalMock,
  hasDurableExecApproval: vi.fn(() => false),
  requiresExecApproval: requiresExecApprovalMock,
  resolveExecApprovalAllowedDecisions: vi.fn(() => ["allow-once", "allow-always", "deny"]),
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

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: registerExecApprovalRequestForHostOrThrowMock,
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  createAndRegisterDefaultExecApprovalRequest: createAndRegisterDefaultExecApprovalRequestMock,
  shouldResolveExecApprovalUnavailableInline: vi.fn(() => false),
  buildExecApprovalFollowupTarget: vi.fn(() => ({ approvalId: "approval-1" })),
  resolveApprovalDecisionOrUndefined: resolveApprovalDecisionOrUndefinedMock,
  createExecApprovalDecisionState: createExecApprovalDecisionStateMock,
  enforceStrictInlineEvalApprovalBoundary: enforceStrictInlineEvalApprovalBoundaryMock,
  sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  DEFAULT_NOTIFY_TAIL_CHARS: 1000,
  createApprovalSlug: vi.fn(() => "slug"),
  normalizeNotifyOutput: vi.fn((value: string) => value),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: listNodesMock,
  resolveNodeIdFromList: vi.fn(() => "node-1"),
}));

vi.mock("../logger.js", () => ({
  logInfo: vi.fn(),
}));

let executeNodeHostCommand: typeof import("./bash-tools.exec-host-node.js").executeNodeHostCommand;

type MockNodeInvokeParams = {
  command?: string;
  params?: Record<string, unknown>;
};

type GatewayToolCall = {
  method: string;
  options: { timeoutMs?: number };
  params?: MockNodeInvokeParams;
  callOptions?: unknown;
};

function requireGatewayCall(index: number): GatewayToolCall {
  const call = callGatewayToolMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected gateway call at index ${index}`);
  }
  const [method, options, params, callOptions] = call as [
    string,
    { timeoutMs?: number },
    MockNodeInvokeParams | undefined,
    unknown,
  ];
  return { method, options, params, callOptions };
}

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

function expectSystemRunInvoke(params: { invokeTimeoutMs: number; runTimeoutMs: number }) {
  const call = requireGatewayCommand("system.run");
  expect(call.options.timeoutMs).toBe(params.invokeTimeoutMs);
  expect(requireRunParams(call).timeoutMs).toBe(params.runTimeoutMs);
}

describe("executeNodeHostCommand", () => {
  beforeAll(async () => {
    ({ executeNodeHostCommand } = await import("./bash-tools.exec-host-node.js"));
  });

  beforeEach(() => {
    callGatewayToolMock.mockReset();
    callGatewayToolMock.mockImplementation(
      async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
        if (method === "exec.approvals.node.get") {
          return { file: { version: 1, agents: {} } };
        }
        if (method === "exec.approval.resolve") {
          return { payload: {} };
        }
        if (method !== "node.invoke") {
          throw new Error(`unexpected gateway method: ${method}`);
        }
        if (params?.command === "system.run.prepare") {
          return { payload: { plan: preparedPlan } };
        }
        if (params?.command === "system.run") {
          return {
            payload: {
              success: true,
              stdout: "ok",
              stderr: "",
              exitCode: 0,
              timedOut: false,
            },
          };
        }
        throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
      },
    );
    listNodesMock.mockReset();
    listNodesMock.mockResolvedValue([
      {
        nodeId: "node-1",
        commands: ["system.run", "system.run.prepare"],
        platform: process.platform,
      },
    ]);
    parsePreparedSystemRunPayloadMock.mockReset();
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: preparedPlan,
      execPolicy: { security: "full", ask: "off" },
    });
    commandRequiresSecurityAuditSuppressionApprovalMock.mockReset();
    commandRequiresSecurityAuditSuppressionApprovalMock.mockReturnValue(false);
    evaluateShellAllowlistMock.mockReset();
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["bun", "./script.ts"] }],
      segmentAllowlistEntries: [],
    });
    resolveExecApprovalsFromFileMock.mockReset();
    resolveExecApprovalsFromFileMock.mockReturnValue({
      allowlist: [],
      file: { version: 1, agents: {} },
      agent: {
        security: "full",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
    });
    requiresExecApprovalMock.mockReset();
    requiresExecApprovalMock.mockReturnValue(true);
    resolveExecHostApprovalContextMock.mockReset();
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "deny",
    });
    createAndRegisterDefaultExecApprovalRequestMock.mockReset();
    createAndRegisterDefaultExecApprovalRequestMock.mockImplementation(async (args?: unknown) => {
      const register =
        args && typeof args === "object" && "register" in args
          ? (args as { register?: (approvalId: string) => Promise<void> }).register
          : undefined;
      await register?.("approval-1");
      return {
        approvalId: "approval-1",
        approvalSlug: "slug-1",
        warningText: "",
        expiresAtMs: Date.now() + 60_000,
        preResolvedDecision: null,
        initiatingSurface: "origin",
        sentApproverDms: false,
        unavailableReason: null,
      };
    });
    resolveApprovalDecisionOrUndefinedMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReset();
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: null,
    });
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      content: [],
      details: { status: "approval-pending" },
    });
    sendExecApprovalFollowupResultMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) => ({
      approvedByAsk: value.approvedByAsk,
      deniedReason: value.deniedReason,
    }));
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    registerExecApprovalRequestForHostOrThrowMock.mockReset();
  });

  it("forwards prepared systemRunPlan on async node invoke after approval", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand({
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
      turnSourceChannel: "telegram",
      turnSourceTo: "telegram:12345",
      turnSourceAccountId: "work",
      turnSourceThreadId: "42",
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(requireRegisteredApprovalRequest().systemRunPlan).toEqual(preparedPlan);

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(3);
    });

    const call = requireGatewayCall(2);
    expect(call.options.timeoutMs).toBe(35_000);
    expect(call.callOptions).toEqual({ scopes: ["operator.write", "operator.approvals"] });
    const runParams = requireRunParams(call);
    expect(runParams.approved).toBe(true);
    expect(runParams.approvalDecision).toBe("allow-once");
    expect(runParams.systemRunPlan).toEqual(preparedPlan);
    expect(runParams.timeoutMs).toBe(30_000);
    expect(runParams.turnSourceChannel).toBe("telegram");
    expect(runParams.turnSourceTo).toBe("telegram:12345");
    expect(runParams.turnSourceAccountId).toBe("work");
    expect(runParams.turnSourceThreadId).toBe("42");
  });

  it("does not build a human approval prompt for node auto-review allows", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe read",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      autoReviewer,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "bun ./script.ts",
        argv: ["bun", "./script.ts"],
        host: "node",
        reason: "allowlist-miss",
      }),
    );
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "node",
        requireDeliveryRoute: false,
        suppressDelivery: true,
      }),
    );
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "exec.approval.resolve",
      { timeoutMs: 15_000 },
      { id: expect.any(String), decision: "allow-once" },
      { scopes: ["operator.approvals"] },
    );
  });

  it("requests human approval when node auto-review asks on an approval miss", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "ask",
      risk: "medium",
      rationale: "needs a person",
    }));
    const warnings: string[] = [];
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      autoReviewer,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings,
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).toHaveBeenCalledTimes(1);
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(warnings.join("\n")).toContain("needs a person");
  });

  it.each([
    {
      name: "ask always",
      nodeSecurity: "full",
      nodeAsk: "always",
    },
    {
      name: "deny security",
      nodeSecurity: "deny",
      nodeAsk: "off",
    },
  ] as const)(
    "requests human approval when node policy has $name floor",
    async ({ nodeSecurity, nodeAsk }) => {
      const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
        decision: "allow-once",
        risk: "low",
        rationale: "test reviewer would allow it",
      }));
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "allowlist",
        hostAsk: "on-miss",
        askFallback: "deny",
      });
      parsePreparedSystemRunPayloadMock.mockReturnValue({
        plan: preparedPlan,
        execPolicy: { security: nodeSecurity, ask: nodeAsk },
      });
      resolveExecApprovalsFromFileMock.mockReturnValue({
        allowlist: [],
        file: { version: 1, agents: {} },
        agent: {
          security: nodeSecurity,
          ask: nodeAsk,
          askFallback: "deny",
          autoAllowSkills: false,
        },
      });
      callGatewayToolMock.mockImplementation(
        async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
          if (method === "exec.approvals.node.get") {
            return { file: { version: 1, agents: {} } };
          }
          if (method === "exec.approval.resolve") {
            return { payload: {} };
          }
          if (method !== "node.invoke") {
            throw new Error(`unexpected gateway method: ${method}`);
          }
          if (params?.command === "system.run.prepare") {
            return {
              payload: {
                plan: preparedPlan,
                execPolicy: { security: nodeSecurity, ask: nodeAsk },
              },
            };
          }
          if (params?.command === "system.run") {
            return {
              payload: {
                success: true,
                stdout: "ok",
                stderr: "",
                exitCode: 0,
                timedOut: false,
              },
            };
          }
          throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
        },
      );

      const result = await executeNodeHostCommand({
        command: "bun ./script.ts",
        workdir: "/tmp/work",
        env: {},
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 0,
        warnings: [],
        agentId: "requested-agent",
        sessionKey: "requested-session",
      });

      expect(result.details?.status).toBe("approval-pending");
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
      expect(
        callGatewayToolMock.mock.calls.some(([method]) => method === "exec.approval.resolve"),
      ).toBe(false);
    },
  );

  it("requests human approval when node approval policy is unavailable", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    callGatewayToolMock.mockImplementation(
      async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
        if (method === "exec.approvals.node.get") {
          throw new Error("node approvals unavailable");
        }
        if (method === "exec.approval.resolve") {
          return { payload: {} };
        }
        if (method !== "node.invoke") {
          throw new Error(`unexpected gateway method: ${method}`);
        }
        if (params?.command === "system.run.prepare") {
          return { payload: { plan: preparedPlan } };
        }
        if (params?.command === "system.run") {
          return {
            payload: {
              success: true,
              stdout: "ok",
              stderr: "",
              exitCode: 0,
              timedOut: false,
            },
          };
        }
        throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
      },
    );

    const result = await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      autoReviewer,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(
      callGatewayToolMock.mock.calls.some(([method]) => method === "exec.approval.resolve"),
    ).toBe(false);
  });

  it("does not use fallback-full when node approval policy is unavailable", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "full",
    });
    callGatewayToolMock.mockImplementation(
      async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
        if (method === "exec.approvals.node.get") {
          throw new Error("node approvals unavailable");
        }
        if (method !== "node.invoke") {
          throw new Error(`unexpected gateway method: ${method}`);
        }
        if (params?.command === "system.run.prepare") {
          return { payload: { plan: preparedPlan } };
        }
        if (params?.command === "system.run") {
          return {
            payload: {
              success: true,
              stdout: "should-not-run",
              stderr: "",
              exitCode: 0,
              timedOut: false,
            },
          };
        }
        throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
      },
    );
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) =>
      value.requiresAutoReviewHumanApproval === true && value.baseDecision.timedOut
        ? { approvedByAsk: false, deniedReason: "approval-timeout" }
        : { approvedByAsk: value.approvedByAsk, deniedReason: value.deniedReason },
    );

    const result = await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      autoReviewer,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec denied (node=node-1 id=approval-1, approval-timeout): bun ./script.ts",
      );
    });
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , params]) =>
          method === "node.invoke" &&
          (params as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("auto-reviews strict inline-eval commands before asking a human", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe inline eval",
    }));
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        {
          resolution: null,
          argv: ["python3", "-c", "print(1)"],
          raw: "python3 -c 'print(1)'",
        },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    const warnings: string[] = [];

    const result = await executeNodeHostCommand({
      command: "python3 -c 'print(1)'",
      workdir: "/tmp/work",
      env: {},
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      autoReviewer,
      strictInlineEval: true,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings,
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "python3 -c 'print(1)'",
        argv: ["python3", "-c", "print(1)"],
        host: "node",
        reason: "strict-inline-eval",
        analysis: expect.objectContaining({
          inlineEval: true,
        }),
      }),
    );
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(warnings[0]).toContain("requires reviewer or explicit approval");
  });

  it("keeps security audit suppression edits off the auto-review path", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    const warnings: string[] = [];
    commandRequiresSecurityAuditSuppressionApprovalMock.mockReturnValue(true);
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand({
      command: "openclaw config set security.audit.suppressions '[]'",
      workdir: "/tmp/work",
      env: {},
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      autoReviewer,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings,
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(warnings).toContain(
      "Warning: security audit suppression changes require explicit approval unless exec is running in yolo mode.",
    );
  });

  it("requests human approval when node auto-review cannot bind a single parsed command", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        { raw: "echo ok", resolution: null, argv: ["echo", "ok"] },
        { raw: "pwd", resolution: null, argv: ["pwd"] },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand({
      command: "echo ok; pwd",
      workdir: "/tmp/work",
      env: {},
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      autoReviewer,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
  });

  it("requests human approval when node runtime policy requires ask always", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: preparedPlan,
      execPolicy: { security: "full", ask: "always" },
    });
    resolveExecApprovalsFromFileMock.mockReturnValue({
      allowlist: [],
      file: { version: 1, agents: {} },
      agent: {
        security: "full",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      autoReviewer,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
  });

  it("does not use fallback-full when node auto-review cannot parse the command", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: false,
      allowlistSatisfied: false,
      segments: [],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "full",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) =>
      value.requiresAutoReviewHumanApproval === true && value.baseDecision.timedOut
        ? { approvedByAsk: false, deniedReason: "approval-timeout" }
        : { approvedByAsk: value.approvedByAsk, deniedReason: value.deniedReason },
    );

    const result = await executeNodeHostCommand({
      command: "echo 'unterminated",
      workdir: "/tmp/work",
      env: {},
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      autoReviewer,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec denied (node=node-1 id=approval-1, approval-timeout): echo 'unterminated",
      );
    });
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , params]) =>
          method === "node.invoke" &&
          (params as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("does not use fallback-full when node auto-review asks for human approval", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "ask",
      risk: "medium",
      rationale: "needs a person",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "full",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) =>
      value.requiresAutoReviewHumanApproval === true && value.baseDecision.timedOut
        ? { approvedByAsk: false, deniedReason: "approval-timeout" }
        : { approvedByAsk: value.approvedByAsk, deniedReason: value.deniedReason },
    );

    const result = await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      autoReviewer,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec denied (node=node-1 id=approval-1, approval-timeout): bun ./script.ts",
      );
    });
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , params]) =>
          method === "node.invoke" &&
          (params as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("builds a local systemRunPlan when approval is required and the node omits prepare", async () => {
    listNodesMock.mockResolvedValueOnce([
      {
        nodeId: "node-1",
        commands: ["system.run", "system.which", "system.notify"],
        platform: "darwin",
      },
    ]);
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand({
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
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(parsePreparedSystemRunPayloadMock).not.toHaveBeenCalled();
    const expectedPlan = {
      argv: ["/bin/sh", "-lc", "bun ./script.ts"],
      cwd: "/tmp/work",
      commandText: '/bin/sh -lc "bun ./script.ts"',
      commandPreview: "bun ./script.ts",
      agentId: "requested-agent",
      sessionKey: "requested-session",
    };
    expect(requireRegisteredApprovalRequest().systemRunPlan).toEqual(expectedPlan);

    await vi.waitFor(() => {
      const call = requireGatewayCommand("system.run");
      expect(call.callOptions).toEqual({ scopes: ["operator.write", "operator.approvals"] });
      const runParams = requireRunParams(call);
      expect(runParams.rawCommand).toBe(expectedPlan.commandText);
      expect(runParams.systemRunPlan).toEqual(expectedPlan);
    });
  });

  it("skips approval prepare in full/off mode", async () => {
    await executeNodeHostCommand({
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
      notifyOnExit: false,
    });

    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
    const call = requireGatewayCall(0);
    expect(call.options.timeoutMs).toBe(35_000);
    const runParams = requireRunParams(call);
    expect(runParams.command).toEqual(["/bin/sh", "-lc", "bun ./script.ts"]);
    expect(runParams.rawCommand).toBe("bun ./script.ts");
    expect(typeof runParams.runId).toBe("string");
    expect(runParams.suppressNotifyOnExit).toBe(true);
    expect(runParams.timeoutMs).toBe(30_000);
    expect(Object.hasOwn(runParams, "systemRunPlan")).toBe(false);
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
      executeNodeHostCommand({
        command: "git log --oneline -5",
        workdir: "/tmp/work",
        env: {},
        security: "allowlist",
        ask: "off",
        requestedNode: "node-1",
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 0,
        warnings: [],
        agentId: "requested-agent",
        sessionKey: "requested-session",
      }),
    ).rejects.toThrow(
      "exec host=node requires a connected node (node-1 is currently disconnected)",
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("returns a non-empty placeholder for silent node exec results", async () => {
    callGatewayToolMock.mockImplementationOnce(
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
        throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
      },
    );

    const result = await executeNodeHostCommand({
      command: "mkdir /tmp/quiet",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
    const details = result.details;
    expect(details?.status).toBe("completed");
    if (details?.status !== "completed") {
      throw new Error(`expected completed details, got ${details?.status ?? "missing"}`);
    }
    expect(details.exitCode).toBe(0);
    expect(details.aggregated).toBe("");
    expect(details.cwd).toBe("/tmp/work");
  });

  it("forwards explicit timeouts to node system.run", async () => {
    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      timeoutSec: 12,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expectSystemRunInvoke({ invokeTimeoutMs: 17_000, runTimeoutMs: 12_000 });
  });

  it("forwards timeout zero to node system.run and keeps the invoke wait bounded", async () => {
    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      timeoutSec: 0,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expectSystemRunInvoke({ invokeTimeoutMs: 35_000, runTimeoutMs: 0 });
  });

  it("auto-reviews strict inline-eval commands with full/off host policy when node policy is available", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe inline eval",
    }));
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        {
          resolution: null,
          argv: ["python3", "-c", "print(1)"],
          raw: "python3 -c 'print(1)'",
        },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand({
      command: "python3 -c 'print(1)'",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      autoReview: true,
      autoReviewer,
      strictInlineEval: true,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "python3 -c 'print(1)'",
        argv: ["python3", "-c", "print(1)"],
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
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "full",
    });

    const result = await executeNodeHostCommand({
      command: "python3 -c 'print(1)'",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      strictInlineEval: true,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec denied (node=node-1 id=approval-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
  });
});
