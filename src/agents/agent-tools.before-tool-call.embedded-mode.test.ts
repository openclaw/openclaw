import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  PluginApprovalResolutions,
  type PluginHookBeforeToolCallResult,
} from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { proposeUpdateSkill } from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveBeforeToolCallApprovalOutcome,
  resolveSkillWorkshopApprovalForFinalParams,
} from "./agent-tools.before-tool-call.approval.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(),
  };
});
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const agentToolsWarnSpy = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      // Capture agents/tools warnings so the deprecation signal is assertable.
      return subsystem === "agents/tools" ? { ...logger, warn: agentToolsWarnSpy } : logger;
    },
  };
});

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockCallGatewayTool = vi.mocked(callGatewayTool);

function pendingWorkshopConfig() {
  return { skills: { workshop: { approvalPolicy: "pending" as const } } };
}

function approvalResult(
  approval: Partial<NonNullable<PluginHookBeforeToolCallResult["requireApproval"]>> = {},
  params?: Record<string, unknown>,
): PluginHookBeforeToolCallResult {
  return {
    requireApproval: {
      pluginId: "test-plugin",
      title: "Needs approval",
      description: "Test approval request",
      ...approval,
    },
    params,
  };
}

function embeddedBroker() {
  setEmbeddedMode(true);
  const broker = new EmbeddedPluginApprovalBroker();
  setEmbeddedPluginApprovalBroker(broker);
  return broker;
}

function trustedPolicy(result: PluginHookBeforeToolCallResult) {
  const registry = createEmptyPluginRegistry();
  registry.trustedToolPolicies = [
    {
      pluginId: "trusted-policy",
      source: "test",
      policy: { id: "test-policy", description: "Test policy", evaluate: () => result },
    },
  ];
  setActivePluginRegistry(registry);
}

const requireRecord = createRequireRecord("record", "expected-label");

function requireApprovalRequestCall(label: string): {
  timeoutParams: Record<string, unknown>;
  request: Record<string, unknown>;
  options: Record<string, unknown>;
} {
  const call = mockCallGatewayTool.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  expect(call[0]).toBe("plugin.approval.request");
  return {
    timeoutParams: requireRecord(call[1], `${label} timeout params`),
    request: requireRecord(call[2], `${label} request`),
    options: requireRecord(call[3], `${label} options`),
  };
}

function requireBeforeToolCall(
  mock: ReturnType<typeof vi.fn<HookRunner["runBeforeToolCall"]>>,
  label: string,
): Parameters<HookRunner["runBeforeToolCall"]> {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

describe("runBeforeToolCallHook — embedded mode approvals", () => {
  let hookRunner: Pick<HookRunner, "hasHooks" | "runBeforeToolCall" | "runSkillProposalChanged">;
  let runBeforeToolCallMock: ReturnType<typeof vi.fn<HookRunner["runBeforeToolCall"]>>;

  beforeEach(() => {
    resetGlobalHookRunner();
    runBeforeToolCallMock = vi.fn<HookRunner["runBeforeToolCall"]>();
    hookRunner = {
      hasHooks: vi.fn<HookRunner["hasHooks"]>().mockReturnValue(true),
      runBeforeToolCall: runBeforeToolCallMock,
      runSkillProposalChanged: vi.fn<HookRunner["runSkillProposalChanged"]>(),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as HookRunner);
    mockCallGatewayTool.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    setEmbeddedPluginApprovalBroker(null);
    setEmbeddedMode(false);
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetGlobalHookRunner();
  });

  it.each(["request", "waitDecision"])(
    "cancels the gateway approval %s transport when the owning tool lifetime ends",
    async (phase) => {
      const controller = new AbortController();
      const parked = createDeferredCore();
      const pending = createDeferredCore<Record<string, unknown>>();
      let transportCancelled = false;
      mockCallGatewayTool.mockImplementation(async (method, _options, _request, extra) => {
        if (method !== `plugin.approval.${phase}`) {
          return { id: "generation-approval", status: "accepted" };
        }
        const signal = extra?.signal;
        const abort = () => {
          transportCancelled = true;
          pending.reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        parked.resolve();
        try {
          return await pending.promise;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      });
      const outcome = resolveBeforeToolCallApprovalOutcome({
        result: approvalResult({ pluginId: "mcp-policy" }),
        toolName: "mcp_write",
        baseParams: {},
        signal: controller.signal,
      });
      try {
        await parked.promise;
        controller.abort(new Error("Permission change"));
        expect(transportCancelled).toBe(true);
        await expect(outcome).resolves.toMatchObject({ blocked: true });
      } finally {
        pending.reject(controller.signal.reason);
        await outcome;
      }
    },
  );

  it("resolves embedded approvals through the in-process TUI broker", async () => {
    const broker = embeddedBroker();
    runBeforeToolCallMock.mockResolvedValue({
      params: { action: "apply", proposal_id: "weather" },
    });

    const resultPromise = runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "apply", proposal_id: "weather" },
      toolCallId: "call-skill-local",
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:main",
        config: pendingWorkshopConfig(),
      },
    });
    await vi.waitFor(() => {
      expect(broker.listPending()).toHaveLength(1);
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );
    expect(approval?.request.toolName).toBe("skill_workshop");
    expect(broker.resolve(approval?.id, "allow-once")).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      blocked: false,
      params: { action: "apply", proposal_id: "weather" },
      approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("does not allow embedded approvals when the broker stops", async () => {
    const broker = embeddedBroker();
    const onResolution = vi.fn();
    runBeforeToolCallMock.mockResolvedValue(
      approvalResult(
        {
          scope: { kind: "external-post", target: "git‮hub", visibility: "public" },
          severity: "info",
          timeoutBehavior: "allow",
          onResolution,
        },
        { adjusted: true },
      ),
    );

    const resultPromise = runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "apply", proposal_id: "weather" },
      toolCallId: "call-skill-stop",
      ctx: { agentId: "main", sessionKey: "agent:main:main" },
    });
    await vi.waitFor(() => {
      expect(broker.listPending()).toHaveLength(1);
    });
    expect(broker.listPending()[0]?.request.scope).toEqual({
      kind: "external-post",
      target: "git\\u{202E}hub",
      visibility: "public",
    });

    broker.stop(new Error("local TUI stopped"));

    await expect(resultPromise).resolves.toMatchObject({
      blocked: true,
      deniedReason: "plugin-approval",
    });
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.CANCELLED);
  });

  it("warns once per plugin when deprecated timeoutBehavior allow arrives, still failing closed", async () => {
    agentToolsWarnSpy.mockClear();
    embeddedBroker();
    const onResolution = vi.fn();
    runBeforeToolCallMock.mockResolvedValue(
      approvalResult({
        pluginId: "deprecated-timeout-plugin",
        timeoutMs: 1,
        timeoutBehavior: "allow",
        onResolution,
      }),
    );

    const first = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-deprecated-warn-1",
      ctx: { agentId: "main", sessionKey: "agent:main:main" },
    });
    const second = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-deprecated-warn-2",
      ctx: { agentId: "main", sessionKey: "agent:main:main" },
    });

    expect(first).toMatchObject({ blocked: true, disposition: "timed_out" });
    expect(second).toMatchObject({ blocked: true, disposition: "timed_out" });
    const deprecationWarnings = agentToolsWarnSpy.mock.calls.filter(
      ([message]) =>
        typeof message === "string" &&
        message.includes("deprecated-timeout-plugin") &&
        message.includes("timeoutBehavior"),
    );
    expect(deprecationWarnings).toHaveLength(1);
    expect(onResolution).toHaveBeenNthCalledWith(1, PluginApprovalResolutions.TIMEOUT);
    expect(onResolution).toHaveBeenNthCalledWith(2, PluginApprovalResolutions.TIMEOUT);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("blocks embedded allow decisions excluded by the request", async () => {
    const broker = embeddedBroker();
    vi.spyOn(broker, "request").mockResolvedValue({
      id: "plugin:unexpected-decision",
      decision: PluginApprovalResolutions.ALLOW_ALWAYS,
    });
    const onResolution = vi.fn();
    runBeforeToolCallMock.mockResolvedValue(
      approvalResult(
        {
          allowedDecisions: ["allow-once", "deny"],
          onResolution,
        },
        { adjusted: true },
      ),
    );

    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "unsafe-command" },
      toolCallId: "call-restricted-approval",
      ctx: { agentId: "main", sessionKey: "agent:main:main" },
    });

    expect(result).toEqual({
      blocked: true,
      kind: "failure",
      disposition: "timed_out",
      deniedReason: "plugin-approval",
      reason: "Approval timed out",
      params: { command: "unsafe-command" },
    });
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.TIMEOUT);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("preserves hook params override after an approval allow decision", async () => {
    setEmbeddedMode(true);

    runBeforeToolCallMock.mockResolvedValue(
      approvalResult({ severity: "info" }, { extraField: "injected" }),
    );
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-3",
      decision: PluginApprovalResolutions.ALLOW_ONCE,
    });

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { path: "/tmp/test.txt", content: "hello" },
      toolCallId: "call-3",
    });

    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.params).toEqual({
        path: "/tmp/test.txt",
        content: "hello",
        extraField: "injected",
      });
    }
  });

  it("routes trusted policy approval through the same approval gate as before_tool_call hooks", async () => {
    setEmbeddedMode(true);
    trustedPolicy(
      approvalResult({
        pluginId: "trusted-policy",
        title: "Policy approval",
        description: "Policy requested approval",
      }),
    );
    (hookRunner.hasHooks as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-policy",
      decision: PluginApprovalResolutions.ALLOW_ONCE,
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "deploy" },
      toolCallId: "call-policy",
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toEqual({
      blocked: false,
      params: { command: "deploy" },
      approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
    });
    const approvalCall = requireApprovalRequestCall("trusted policy approval request");
    expect(approvalCall.timeoutParams.timeoutMs).toBe(130_000);
    expect(approvalCall.request.pluginId).toBeUndefined();
    expect(approvalCall.request.title).toBe("Policy approval");
    expect(approvalCall.request.description).toBe("Policy requested approval");
    expect(approvalCall.request.toolName).toBe("exec");
    expect(approvalCall.request.toolCallId).toBe("call-policy");
    expect(approvalCall.request.agentId).toBe("main");
    expect(approvalCall.request.sessionKey).toBe("main");
    expect(approvalCall.request.twoPhase).toBe(true);
    expect(approvalCall.options.expectFinal).toBe(false);
    expect(runBeforeToolCallMock).not.toHaveBeenCalled();
  });

  it("requires approval when a hook rewrites skill_workshop inspection into applying a proposal", async () => {
    const params = { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" };
    runBeforeToolCallMock.mockResolvedValue({ params });
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "skill-workshop-approval",
      decision: PluginApprovalResolutions.ALLOW_ONCE,
    });
    const result = await runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { ...params, action: "inspect" },
      toolCallId: "call-skill-hook-apply",
      ctx: { config: pendingWorkshopConfig() },
    });
    expect(result).toEqual({
      blocked: false,
      params,
      approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
    });
    const approvalCall = requireApprovalRequestCall("skill_workshop adjusted approval request");
    expect(approvalCall.request.pluginId).toBeUndefined();
    expect(approvalCall.request).toMatchObject({
      title: "Apply Skill Workshop proposal",
      description: "Apply a pending proposal inside your agent's Workshop directory.",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      timeoutMs: 70_000,
      toolName: "skill_workshop",
      toolCallId: "call-skill-hook-apply",
    });
    expect(approvalCall.timeoutParams.timeoutMs).toBe(80_000);
    expect(runBeforeToolCallMock).toHaveBeenCalledOnce();
  });

  it("does not expose another agent's proposal metadata in final approval", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-agent-approval-scope-",
    });
    try {
      const config = {
        skills: { workshop: { approvalPolicy: "pending" as const } },
      };
      const skillsRoot = resolveWorkshopSkillsDir(config, "agent-a", testState.env);
      const skillDir = `${skillsRoot}/agent-a-private-procedure`;
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        `${skillDir}/SKILL.md`,
        "---\nname: agent-a-private-procedure\ndescription: Agent A private description\n---\n\n# Agent A private body\n",
        "utf8",
      );
      const proposal = await proposeUpdateSkill({
        config,
        agentId: "agent-a",
        workspaceDir: testState.workspaceDir,
        env: testState.env,
        skillName: "agent-a-private-procedure",
        description: "Agent A private description",
        content: "# Agent A private body\n",
      });
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "agent-b-approval",
        decision: PluginApprovalResolutions.ALLOW_ONCE,
      });

      const result = await resolveSkillWorkshopApprovalForFinalParams({
        toolName: "skill_workshop",
        params: { action: "apply", proposal_id: proposal.record.id },
        toolCallId: "call-agent-b-apply",
        ctx: {
          agentId: "agent-b",
          workspaceDir: testState.workspaceDir,
          config,
        },
      });

      expect(result).toMatchObject({
        blocked: false,
        approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
      });
      const approvalCall = requireApprovalRequestCall(
        "agent-b final skill_workshop approval request",
      );
      expect(approvalCall.request.description).toBe(
        "Apply a pending proposal inside your agent's Workshop directory.",
      );
      expect(approvalCall.request.description).not.toContain("Agent A private");
    } finally {
      await testState.cleanup();
    }
  });

  it("returns an actionable pending outcome when skill_workshop approval expires", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "skill-workshop-timeout",
      status: "accepted",
    });
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "skill-workshop-timeout",
      decision: null,
    });

    const result = await runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      toolCallId: "call-skill-timeout",
      ctx: {
        agentId: "main",
        sessionKey: "main",
        config: pendingWorkshopConfig(),
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "plugin-approval",
      reason:
        "The Skill Workshop approval request expired without a decision. This lifecycle call left the proposal unchanged and pending; check its current status in case another operator acted on it. Decide in the Skill Workshop UI or run `openclaw skills workshop apply|reject|quarantine <id>`. Do not retry this tool call in a loop.",
    });
  });

  it("runs trusted policies before skill_workshop lifecycle approval", async () => {
    trustedPolicy({ block: true, blockReason: "trusted policy blocked skill workshop" });
    (hookRunner.hasHooks as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      toolCallId: "call-skill-apply",
      ctx: {
        config: pendingWorkshopConfig(),
      },
    });

    expect(result).toEqual({
      blocked: true,
      kind: "veto",
      deniedReason: "plugin-before-tool-call",
      reason: "trusted policy blocked skill workshop",
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(runBeforeToolCallMock).not.toHaveBeenCalled();
  });

  it("uses runtime config for skill_workshop pending mode when hook context config is absent", async () => {
    (hookRunner.hasHooks as ReturnType<typeof vi.fn>).mockReturnValue(false);
    setRuntimeConfigSnapshot(pendingWorkshopConfig());
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "skill-workshop-runtime-approval",
      decision: PluginApprovalResolutions.ALLOW_ONCE,
    });

    const result = await runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toEqual({
      blocked: false,
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
    });
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
    expect(runBeforeToolCallMock).not.toHaveBeenCalled();
  });

  it("preserves trusted policy params when before_tool_call hooks leave params unchanged", async () => {
    trustedPolicy({ params: { command: "patched" } });
    runBeforeToolCallMock.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "original", cwd: "/tmp" },
      toolCallId: "call-policy-params",
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toEqual({ blocked: false, params: { command: "patched" } });
    const [hookParams, hookContext] = requireBeforeToolCall(
      runBeforeToolCallMock,
      "before_tool_call invocation",
    );
    expect(hookParams.params).toEqual({ command: "patched" });
    expect(hookParams.toolName).toBe("exec");
    expect(hookParams.toolCallId).toBe("call-policy-params");
    expect(typeof hookContext).toBe("object");
  });
});

describe("before_tool_call approval snapshots", () => {
  it("detaches deferred approval params from mutable hook and caller objects", async () => {
    const baseParams = { command: "safe", options: { cwd: "/safe" } };
    const overrideParams = { env: { MODE: "safe" } };

    const outcome = await resolveBeforeToolCallApprovalOutcome({
      result: approvalResult({ pluginId: "policy" }, overrideParams),
      approvalMode: "defer",
      toolName: "bash",
      toolCallId: "snapshot-call",
      ctx: { agentId: "main" },
      baseParams,
    });

    baseParams.options.cwd = "/unapproved";
    overrideParams.env.MODE = "unapproved";

    expect(outcome).toMatchObject({
      blocked: false,
      params: { command: "safe", options: { cwd: "/safe" } },
      deferredApproval: {
        baseParams: { command: "safe", options: { cwd: "/safe" } },
        overrideParams: { env: { MODE: "safe" } },
      },
    });
    if (!outcome || outcome.blocked || !outcome.deferredApproval) {
      throw new Error("expected deferred approval outcome");
    }
    (outcome.params as typeof baseParams).options.cwd = "/outcome-mutated";
    expect(outcome.deferredApproval.baseParams).toEqual({
      command: "safe",
      options: { cwd: "/safe" },
    });
  });

  it.each(["base", "override"] as const)("rejects shared memory in %s params", async (location) => {
    const shared = { shared: new Uint8Array(new SharedArrayBuffer(4)) };
    await expect(
      resolveBeforeToolCallApprovalOutcome({
        result: approvalResult(
          { pluginId: "policy" },
          location === "override" ? shared : undefined,
        ),
        approvalMode: "defer",
        toolName: "bash",
        baseParams: location === "base" ? shared : { command: "safe" },
      }),
    ).rejects.toThrow("before_tool_call mutable input isolation failed");
  });
});
