/**
 * Integration-style tests for before_tool_call behavior.
 * Covers loop detection, diagnostics, plugin approval, and skill telemetry
 * around wrapped tool execution.
 */
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { MAX_PLUGIN_APPROVAL_TIMEOUT_MS } from "../infra/plugin-approvals.js";
import { resetDiagnosticRunActivityForTest } from "../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { PluginApprovalResolutions } from "../plugins/hook-before-tool-call-result.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  getBeforeToolCallPolicyDiagnosticState,
  runBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { callGatewayTool } from "./tools/gateway.js";

afterEach(() => {
  resetDiagnosticRunActivityForTest();
  setGlobalHookRunnerForTest(null);
  mockGetGlobalHookRunner.mockReset();
  mockGetGlobalHookRunner.mockImplementation(() => getGlobalHookRunnerForTest());
});

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(actual.getGlobalHookRunner),
  };
});
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");

function setGlobalHookRunnerForTest(hookRunner: HookRunner | null): void {
  const hookRunnerGlobalState = globalThis as Record<
    symbol,
    { hookRunner: HookRunner | null; registry?: unknown } | undefined
  >;
  if (!hookRunnerGlobalState[hookRunnerGlobalStateKey]) {
    hookRunnerGlobalState[hookRunnerGlobalStateKey] = {
      hookRunner: null,
      registry: null,
    };
  }
  hookRunnerGlobalState[hookRunnerGlobalStateKey].hookRunner = hookRunner;
}

function getGlobalHookRunnerForTest(): HookRunner | null {
  const hookRunnerGlobalState = globalThis as Record<
    symbol,
    { hookRunner: HookRunner | null; registry?: unknown } | undefined
  >;
  return hookRunnerGlobalState[hookRunnerGlobalStateKey]?.hookRunner ?? null;
}

type TestHookRunner = HookRunner & {
  hasHooks: ReturnType<typeof vi.fn<HookRunner["hasHooks"]>>;
  runBeforeToolCall: ReturnType<typeof vi.fn<HookRunner["runBeforeToolCall"]>>;
};

function createTestHookRunner(): TestHookRunner {
  return {
    ...createHookRunner(createEmptyPluginRegistry()),
    hasHooks: vi.fn<HookRunner["hasHooks"]>(),
    runBeforeToolCall: vi.fn<HookRunner["runBeforeToolCall"]>(),
  };
}

describe("before_tool_call requireApproval handling", () => {
  let hookRunner: TestHookRunner;
  const mockCallGateway = vi.mocked(callGatewayTool);

  const requireRecord = createRequireRecord("object", "label-not-object");

  function requireHookCall(
    index: number,
  ): [event: Record<string, unknown>, context: Record<string, unknown>] {
    const call = hookRunner.runBeforeToolCall.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing before_tool_call hook call ${index + 1}`);
    }
    return [
      requireRecord(call[0], "before_tool_call event"),
      requireRecord(call[1], "before_tool_call context"),
    ];
  }

  function requireGatewayCall(index: number): unknown[] {
    const call = mockCallGateway.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing gateway call ${index + 1}`);
    }
    return call;
  }

  function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
  }

  function registerTelegramPluginApprovalSetup(): void {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
            approvalCapability: {
              native: {},
              getActionAvailabilityState: () => ({ kind: "enabled" as const }),
              getExecInitiatingSurfaceState: () => ({ kind: "disabled" as const }),
              describePluginApprovalSetup: () => "Configure Telegram native approval setup.",
            },
          },
        },
      ]),
    );
  }

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = createTestHookRunner();
    hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_tool_call");
    mockGetGlobalHookRunner.mockReturnValue(hookRunner);
    // Keep the global singleton aligned as a fallback in case another setup path
    // preloads hook-runner-global before this test's module reset/mocks take effect.
    setGlobalHookRunnerForTest(hookRunner);
    mockCallGateway.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("blocks without triggering approval when both block and requireApproval are set", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "Blocked by security plugin",
      requireApproval: {
        title: "Should not reach gateway",
        description: "This approval should be skipped",
        pluginId: "lower-priority-plugin",
      },
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Blocked by security plugin");
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it("blocks when before_tool_call hook execution throws", async () => {
    hookRunner.runBeforeToolCall.mockRejectedValueOnce(new Error("hook crashed"));

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "ls" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("disposition", "failed");
    expect(result).toHaveProperty(
      "reason",
      "Tool call blocked because before_tool_call hook failed",
    );
  });

  it("classifies a loop preflight exception as a before-tool failure", async () => {
    const ctx = {
      sessionKey: "main",
      get loopDetection(): never {
        throw new Error("loop state unavailable");
      },
    };

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "ls" },
      ctx,
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "failure",
      disposition: "failed",
      reason: "Tool call blocked because before_tool_call hook failed",
    });
  });

  it("passes diagnostic trace context to before_tool_call hooks", async () => {
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "pwd" },
      toolCallId: "tool-1",
      ctx: { agentId: "main", sessionKey: "main", runId: "run-1", trace },
    });

    expect(result.blocked).toBe(false);
    const [event, toolContext] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "exec",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expectRecordFields(toolContext, {
      toolName: "exec",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expect(toolContext.trace).toEqual(trace);
    expect(toolContext.trace).not.toBe(trace);
    expect(Object.isFrozen(toolContext.trace)).toBe(true);
  });

  it("passes host-derived apply_patch paths to before_tool_call hooks", async () => {
    const cwd = path.join("/tmp", "openclaw-hooks");
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** Update File: src/old.ts",
      "*** Move to: src/renamed.ts",
      "@@",
      "+y",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-1",
      ctx: { agentId: "main", cwd, sessionKey: "main", runId: "run-patch" },
    });

    expect(result.blocked).toBe(false);
    const [event, context] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-1",
      derivedPaths: [
        path.join(cwd, "src/new.ts"),
        path.join(cwd, "src/old.ts"),
        path.join(cwd, "src/renamed.ts"),
        path.join(cwd, "src/dead.ts"),
      ],
    });
    expectRecordFields(context, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-1",
    });
  });

  it("derives sandboxed apply_patch paths through the sandbox bridge", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /workspace/src/new.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-sandbox",
      ctx: {
        agentId: "main",
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath: ({ filePath }: { filePath: string }) => ({
              containerPath: filePath,
              hostPath: "/host/sandbox/src/new.ts",
              relativePath: "src/new.ts",
            }),
          } as never,
        },
        sessionKey: "main",
        runId: "run-patch",
      },
    });

    expect(result.blocked).toBe(false);
    const [event] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "apply_patch",
      derivedPaths: ["/host/sandbox/src/new.ts"],
    });
  });

  it("derives remote apply_patch shorthand and literal paths like execution", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: @reference.md",
      "@@",
      "+reference",
      "*** Update File: @literal.md",
      "@@",
      "+literal",
      "*** End Patch",
    ].join("\n");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);
    const resolvePath = ({ filePath }: { filePath: string }) => ({
      containerPath: path.posix.resolve("/workspace", filePath),
      relativePath: filePath,
    });

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-remote-at",
      ctx: {
        agentId: "main",
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath,
            stat: async ({ filePath }: { filePath: string }) =>
              filePath === "./@literal.md" ? { type: "file", size: 7, mtimeMs: 0 } : null,
          } as never,
        },
        sessionKey: "main",
        runId: "run-patch",
      },
    });

    expect(result.blocked).toBe(false);
    const [event] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "apply_patch",
      derivedPaths: ["/workspace/reference.md", "/workspace/@literal.md"],
    });
  });

  it("preserves bridge-native absolute apply_patch paths", async () => {
    const rawPath = "/workspace//src/new.ts";
    const patch = ["*** Begin Patch", `*** Add File: ${rawPath}`, "+new", "*** End Patch"].join(
      "\n",
    );
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
      containerPath: path.posix.normalize(filePath),
      relativePath: filePath,
    }));
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      ctx: {
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: { resolvePath } as never,
        },
      },
    });

    expect(result.blocked).toBe(false);
    expect(resolvePath).toHaveBeenCalledWith({ filePath: rawPath, cwd: "/workspace" });
  });

  it("cancels remote apply_patch path derivation with the run", async () => {
    const controller = new AbortController();
    let reportStatSignal!: (signal: AbortSignal | undefined) => void;
    const statStarted = new Promise<AbortSignal | undefined>((resolve) => {
      reportStatSignal = resolve;
    });
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const running = runBeforeToolCallHook({
      toolName: "apply_patch",
      params: {
        input: ["*** Begin Patch", "*** Update File: @remote.md", "*** End Patch"].join("\n"),
      },
      signal: controller.signal,
      ctx: {
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath: ({ filePath }: { filePath: string }) => ({
              containerPath: path.posix.resolve("/workspace", filePath),
              relativePath: filePath,
            }),
            stat: ({ signal }: { signal?: AbortSignal }) => {
              reportStatSignal(signal);
              if (!signal) {
                return Promise.resolve(null);
              }
              return new Promise((_, reject) => {
                signal.addEventListener(
                  "abort",
                  () =>
                    reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
                  { once: true },
                );
              });
            },
          } as never,
        },
      },
    });

    const statSignal = await statStarted;
    controller.abort();
    expect(statSignal).toBe(controller.signal);
    await expect(running).resolves.toMatchObject({
      blocked: true,
      kind: "failure",
      disposition: "cancelled",
    });
  });

  it("does not fail hooks when sandbox path derivation rejects a target", async () => {
    const patch = ["*** Begin Patch", "*** Add File: /outside.ts", "+x", "*** End Patch"].join(
      "\n",
    );
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-sandbox-rejected",
      ctx: {
        agentId: "main",
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath: () => {
              throw new Error("Path escapes sandbox root");
            },
          } as never,
        },
        sessionKey: "main",
        runId: "run-patch",
      },
    });

    expect(result.blocked).toBe(false);
    const [event, context] = requireHookCall(0);
    expect(event).not.toHaveProperty("derivedPaths");
    expectRecordFields(context, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-sandbox-rejected",
    });
  });

  it("skips derived path extraction when no policies or hooks can consume it", async () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const params = {};
    Object.defineProperty(params, "input", {
      enumerable: true,
      get() {
        throw new Error("should not derive paths");
      },
    });

    await expect(
      runBeforeToolCallHook({
        toolName: "apply_patch",
        params,
        toolCallId: "patch-no-hooks",
      }),
    ).resolves.toEqual({ blocked: false, params });
    expect(hookRunner.runBeforeToolCall).not.toHaveBeenCalled();
  });

  it("reports trusted policy diagnostics through guarded readers", () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const registry = createEmptyPluginRegistry();
    const unreadableIdPolicy: Record<string, unknown> = {
      description: "synthetic trusted policy",
      evaluate: () => undefined,
    };
    Object.defineProperty(unreadableIdPolicy, "id", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin trusted policy id is unreadable");
      },
    });
    registry.trustedToolPolicies = [
      {
        pluginId: "fuzzplugin",
        pluginName: "Fuzz Plugin",
        source: "test",
        policy: unreadableIdPolicy as never,
      },
      {
        pluginId: "mockplugin",
        pluginName: "Mock Plugin",
        source: "test",
        policy: {
          id: "mockpolicy",
          description: "mock policy",
          evaluate: () => undefined,
        },
      },
    ];
    setActivePluginRegistry(registry);

    let state: ReturnType<typeof getBeforeToolCallPolicyDiagnosticState> | undefined;
    try {
      state = getBeforeToolCallPolicyDiagnosticState();
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
    }

    expect(state).toEqual({
      hasBeforeToolCallHook: false,
      trustedToolPolicies: [
        {
          id: "fuzzplugin",
          pluginId: "fuzzplugin",
          pluginName: "Fuzz Plugin",
        },
        {
          id: "mockpolicy",
          pluginId: "mockplugin",
          pluginName: "Mock Plugin",
        },
      ],
    });
  });

  it("recomputes host-derived paths after trusted policy param rewrites", async () => {
    const cwd = path.join("/tmp", "openclaw-hooks");
    const originalPatch = [
      "*** Begin Patch",
      "*** Add File: src/old.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const rewrittenPatch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const seenByLaterPolicy: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-rewriter",
        pluginName: "Trusted Rewriter",
        source: "test",
        policy: {
          id: "rewrite",
          description: "rewrite",
          evaluate: () => ({ params: { input: rewrittenPatch } }),
        },
      },
      {
        pluginId: "trusted-inspector",
        pluginName: "Trusted Inspector",
        source: "test",
        policy: {
          id: "inspect",
          description: "inspect",
          evaluate: (event) => {
            seenByLaterPolicy.push(event.derivedPaths);
            return undefined;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: originalPatch },
      toolCallId: "patch-rewrite",
      ctx: { agentId: "main", cwd, sessionKey: "main", runId: "run-patch" },
    });

    expect(result).toEqual({ blocked: false, params: { input: rewrittenPatch } });
    expect(seenByLaterPolicy).toEqual([[path.join(cwd, "src/new.ts")]]);
    const [event] = requireHookCall(0);
    expectRecordFields(event, {
      params: { input: rewrittenPatch },
      derivedPaths: [path.join(cwd, "src/new.ts")],
    });
  });

  it("calls gateway RPC and unblocks on allow-once", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Sensitive",
        description: "Sensitive op",
        pluginId: "sage",
      },
    });

    // First call: plugin.approval.request → returns server-generated id
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-1", status: "accepted" });
    // Second call: plugin.approval.waitDecision → returns allow-once
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-1", decision: "allow-once" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(false);
    expect(mockCallGateway).toHaveBeenCalledTimes(2);
    const requestCall = requireGatewayCall(0);
    expect(requestCall[0]).toBe("plugin.approval.request");
    requireRecord(requestCall[1], "approval request gateway client");
    expect(requireRecord(requestCall[2], "approval request params").twoPhase).toBe(true);
    expect(requestCall[3]).toEqual({ expectFinal: false });
    const waitCall = requireGatewayCall(1);
    expect(waitCall[0]).toBe("plugin.approval.waitDecision");
    requireRecord(waitCall[1], "approval wait gateway client");
    expect(waitCall[2]).toEqual({ id: "server-id-1" });
  });

  it("caps oversized plugin approval timeouts before calling gateway", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Oversized timeout",
        description: "Still valid gateway payload",
        pluginId: "sage",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-oversized", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-oversized", decision: "allow-once" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(false);
    const requestCall = requireGatewayCall(0);
    expect(requireRecord(requestCall[1], "approval request gateway client").timeoutMs).toBe(
      MAX_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000,
    );
    expect(requireRecord(requestCall[2], "approval request params").timeoutMs).toBe(
      MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
    );
    const waitCall = requireGatewayCall(1);
    expect(requireRecord(waitCall[1], "approval wait gateway client").timeoutMs).toBe(
      MAX_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000,
    );
  });

  it("uses tool-neutral guidance for a denied plugin tool call", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Dangerous",
        description: "Dangerous op",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-2", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-2", decision: "deny" });

    const result = await runBeforeToolCallHook({
      toolName: "web_search",
      params: { query: "OpenClaw" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("disposition", "blocked");
    expect(result).toHaveProperty(
      "reason",
      [
        "Denied by user. The tool call did not run.",
        "This denial is final: the approval request is closed. Do not mention /approve or any other approval command to the user.",
        "Do not run the tool call again or ask the user to approve it again.",
        "If the user still wants the action, explain that a new tool call will trigger a fresh approval request.",
      ].join("\n"),
    );
  });

  it("keeps the generic plugin approval timeout reason unchanged", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Timeout test",
        description: "Will time out",
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-timeout", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-timeout", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "failure",
      reason: "Approval timed out",
    });
  });

  it("blocks turn-source plugin approval timeouts with setup guidance", async () => {
    registerTelegramPluginApprovalSetup();
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Timeout test",
        description: "Will time out",
      },
    });

    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-3",
      status: "accepted",
      deliveryRoute: "turn-source",
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-3", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: {
        agentId: "main",
        sessionKey: "main",
        turnSourceChannel: "telegram",
        turnSourceTo: "-100123456789",
        turnSourceAccountId: "default",
      },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("disposition", "timed_out");
    expect(result).toHaveProperty(
      "reason",
      "Approval timed out\n\nConfigure Telegram native approval setup.",
    );
  });

  it.each([
    ["a timeout", null],
    ["an explicit timeout decision", PluginApprovalResolutions.TIMEOUT],
    ["an unknown decision", "approved"],
    ["a malformed truthy decision", true as unknown as string],
  ])("blocks on %s even when deprecated timeoutBehavior is allow", async (_label, decision) => {
    const onResolution = vi.fn();
    hookRunner.runBeforeToolCall.mockResolvedValue({
      params: { command: "safe-command" },
      requireApproval: {
        title: "Lenient timeout",
        description: "Must fail closed",
        timeoutBehavior: "allow",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-4", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-4", decision });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf /" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "failure",
      disposition: "timed_out",
      deniedReason: "plugin-approval",
      reason: "Approval timed out",
      params: { command: "rm -rf /" },
    });
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.TIMEOUT);
  });
});
