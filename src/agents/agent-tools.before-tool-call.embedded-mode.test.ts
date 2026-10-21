import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { resolveBeforeToolCallApprovalOutcome } from "./agent-tools.before-tool-call.approval.js";
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

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockCallGatewayTool = vi.mocked(callGatewayTool);

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

describe("runBeforeToolCallHook — embedded mode approvals", () => {
  const hasHooks = vi.fn<HookRunner["hasHooks"]>();
  const runBeforeToolCallMock = vi.fn<HookRunner["runBeforeToolCall"]>();
  const call = (options: Partial<Parameters<typeof runBeforeToolCallHook>[0]>) =>
    runBeforeToolCallHook({
      toolName: "demo_write",
      params: { path: "notes.md" },
      ctx: { agentId: "main", sessionKey: "agent:main:main" },
      ...options,
    });

  beforeEach(() => {
    resetGlobalHookRunner();
    runBeforeToolCallMock.mockReset();
    hasHooks.mockReset().mockReturnValue(true);
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks,
      runBeforeToolCall: runBeforeToolCallMock,
    } as HookRunner);
    mockCallGatewayTool.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterEach(() => {
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
    runBeforeToolCallMock.mockResolvedValue(approvalResult({}, { path: "notes.md" }));

    const resultPromise = call({ toolCallId: "call-demo-local" });
    await vi.waitFor(() => {
      expect(broker.listPending()).toHaveLength(1);
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );
    expect(approval?.request.toolName).toBe("demo_write");
    expect(broker.resolve(approval?.id, "allow-once")).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      blocked: false,
      params: { path: "notes.md" },
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
          onResolution,
        },
        { adjusted: true },
      ),
    );

    const resultPromise = call({ toolCallId: "call-demo-stop" });
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

  it.each([
    ["timeouts", null],
    ["allow decisions excluded by the request", PluginApprovalResolutions.ALLOW_ALWAYS],
  ] as const)("blocks embedded %s", async (_label, decision) => {
    const broker = embeddedBroker();
    vi.spyOn(broker, "request").mockResolvedValue({
      id: "plugin:unexpected-decision",
      decision,
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

    const result = await call({
      toolName: "exec",
      params: { command: "unsafe-command" },
      toolCallId: "call-restricted-approval",
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

  it("routes trusted policy approval through the same approval gate as before_tool_call hooks", async () => {
    setEmbeddedMode(true);
    trustedPolicy(
      approvalResult({
        pluginId: "trusted-policy",
        title: "Policy approval",
        description: "Policy requested approval",
      }),
    );
    hasHooks.mockReturnValue(false);
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
    expect(mockCallGatewayTool.mock.calls[0]).toEqual([
      "plugin.approval.request",
      { timeoutMs: 130_000 },
      expect.objectContaining({
        title: "Policy approval",
        description: "Policy requested approval",
        toolName: "exec",
        toolCallId: "call-policy",
        agentId: "main",
        sessionKey: "main",
        twoPhase: true,
      }),
      expect.objectContaining({ expectFinal: false }),
    ]);
    expect(mockCallGatewayTool.mock.calls[0]?.[2]).not.toHaveProperty("pluginId");
    expect(runBeforeToolCallMock).not.toHaveBeenCalled();
  });

  it.each(["rewrite", "mutation"])(
    "rejects an ordinary hook %s after trusted policy approval",
    async (mode) => {
      trustedPolicy(approvalResult({ pluginId: "trusted-policy" }));
      runBeforeToolCallMock.mockImplementation((event) => {
        if (mode === "rewrite") {
          return Promise.resolve({ params: { command: "unapproved" } });
        }
        event.params.command = "unapproved";
        return Promise.resolve(undefined);
      });
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-policy",
        decision: PluginApprovalResolutions.ALLOW_ONCE,
      });

      await expect(
        runBeforeToolCallHook({
          toolName: "bash",
          params: { command: "approved" },
        }),
      ).resolves.toMatchObject({
        blocked: true,
        deniedReason: "plugin-approval",
        reason: "Tool call parameters changed after trusted approval",
        params: { command: "approved" },
      });
    },
  );
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
