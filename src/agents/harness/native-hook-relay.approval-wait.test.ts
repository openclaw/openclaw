import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { callGatewayTool } from "../tools/gateway.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
import {
  invokeNativeHookRelay,
  registerNativeHookRelay,
  registerOwnedNativeHookRelay,
  testing,
} from "./native-hook-relay.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const approvalMocks = vi.hoisted(() => ({ loadExecApprovalsReadOnly: vi.fn() }));

vi.mock("../../infra/exec-approvals-store.js", () => ({
  loadExecApprovalsReadOnly: approvalMocks.loadExecApprovalsReadOnly,
  loadExecApprovalsReadOnlyAsync: async () => approvalMocks.loadExecApprovalsReadOnly(),
}));

beforeEach(() => {
  approvalMocks.loadExecApprovalsReadOnly.mockReset().mockReturnValue({ version: 1, agents: {} });
});

afterEach(async () => {
  vi.restoreAllMocks();
  mockCallGatewayTool.mockReset();
  await testing.clearNativeHookRelaysForTests();
});

describe("native hook relay approval wait handling", () => {
  it.each([
    {
      name: "relay/run tuple",
      relayIds: ["a", "a:b"],
      runIds: ["b:c", "c"],
      callIds: ["call", "call"],
    },
    {
      name: "relay prefix",
      relayIds: ["a", "a:b"],
      runIds: ["run", "run"],
      callIds: ["one", "two"],
    },
    {
      name: "explicit call versus fallback",
      relayIds: ["a", "a"],
      runIds: ["run", "run"],
      callIds: [undefined, "keys:none"],
    },
  ])("isolates permission ownership across $name keys", async ({ relayIds, runIds, callIds }) => {
    const host = await createAdmittedHostCapabilityTestFixture({ runId: "tuple-owner" });
    const held = [
      createDeferredCore<{ id: string; decision: string }>(),
      createDeferredCore<{ id: string; decision: string }>(),
    ];
    const signals: AbortSignal[] = [];
    mockCallGatewayTool.mockImplementation(async (method, _opts, _params, extra) => {
      if (method !== "plugin.approval.request" || !extra?.signal) {
        throw new Error("unexpected approval request");
      }
      signals.push(extra.signal);
      return await held[signals.length - 1]!.promise;
    });
    const firstRelay = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: relayIds[0],
      sessionId: "tuple-session",
      runId: runIds[0]!,
      approvalHost: host.hostCapabilities,
    });
    const secondRelay =
      relayIds[0] === relayIds[1]
        ? firstRelay
        : registerOwnedNativeHookRelay({
            provider: "codex",
            relayId: relayIds[1],
            sessionId: "tuple-session",
            runId: runIds[1]!,
            approvalHost: host.hostCapabilities,
          });
    await Promise.all([firstRelay.ready, secondRelay.ready]);
    const invoke = (
      relay: typeof firstRelay,
      toolUseId: string | undefined,
      signal?: AbortSignal,
    ) =>
      invokeNativeHookRelay(
        {
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
          event: "permission_request",
          rawPayload: {
            tool_name: "call",
            ...(toolUseId ? { tool_use_id: toolUseId } : {}),
            tool_input: {},
          },
        },
        signal,
      );
    const controller = new AbortController();
    const first = invoke(firstRelay, callIds[0], controller.signal);
    void first.catch(() => {});
    let second: ReturnType<typeof invoke> | undefined;
    let duplicate: ReturnType<typeof invoke> | undefined;
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      second = invoke(secondRelay, callIds[1]);
      void second.catch(() => {});
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      expect(nativeHookRelayState.pendingPermissionApprovals.size).toBe(2);
      duplicate = invoke(secondRelay, callIds[1]);
      await vi.waitFor(() =>
        expect(
          [...nativeHookRelayState.pendingPermissionApprovals.values()]
            .map((entry) => entry.waiters)
            .toSorted((a, b) => a - b),
        ).toEqual([1, 2]),
      );
      if (firstRelay === secondRelay) {
        controller.abort();
      } else {
        firstRelay.unregister();
      }
      await expect(first).rejects.toThrow(firstRelay === secondRelay ? /abort/i : /inactive/);
      await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
      expect(signals[1]?.aborted).toBe(false);
      host.hostCapabilities.assertActive();
      held[1]!.resolve({ id: "second", decision: "allow-always" });
      for (const response of await Promise.all([second, duplicate])) {
        expect(JSON.parse(response.stdout).hookSpecificOutput.decision.behavior).toBe("allow");
      }
      held[0]!.resolve({ id: "first", decision: "allow-always" });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect([...nativeHookRelayState.permissionAllowAlwaysApprovals.values()]).toEqual([
        expect.objectContaining({ relayId: secondRelay.relayId }),
      ]);
      const cached = await invoke(secondRelay, "next-call");
      expect(JSON.parse(cached.stdout).hookSpecificOutput.decision.behavior).toBe("allow");
      expect(signals).toHaveLength(2);
    } finally {
      controller.abort();
      firstRelay.unregister();
      secondRelay.unregister();
      for (const decision of held) {
        decision.resolve({ id: "cleanup", decision: "deny" });
      }
      await Promise.allSettled([first, second, ...(duplicate ? [duplicate] : [])]);
      await Promise.all([firstRelay.drain(), secondRelay.drain()]);
      host.closeHost();
      host.closeAdmission();
    }
  });

  it.each(["request", "waitDecision"])(
    "rejoins a public approval after every %s waiter disconnects",
    async (phase) => {
      const held = createDeferredCore<{ id: string; decision: string }>();
      let requestSignal: AbortSignal | undefined;
      mockCallGatewayTool.mockImplementation(async (method, _opts, _params, extra) => {
        if (method === `plugin.approval.${phase}`) {
          requestSignal = extra?.signal;
          return await held.promise;
        }
        if (method === "plugin.approval.request") {
          return { id: "public-approval", status: "accepted" };
        }
        throw new Error(`unexpected gateway method: ${method}`);
      });
      const relay = registerNativeHookRelay({
        provider: "codex",
        sessionId: "public-approval",
        runId: "public-approval",
      });
      const invoke = (signal?: AbortSignal) =>
        invokeNativeHookRelay(
          {
            provider: "codex",
            relayId: relay.relayId,
            event: "permission_request",
            rawPayload: { tool_name: "fixture", tool_use_id: "public-call", tool_input: {} },
          },
          signal,
        );
      const controller = new AbortController();
      const first = invoke(controller.signal);
      void first.catch(() => {});
      try {
        await vi.waitFor(() => expect(requestSignal).toBeDefined());
        controller.abort();
        await expect(first).rejects.toThrow(/abort/i);
        await vi.waitFor(() =>
          expect([...nativeHookRelayState.pendingPermissionApprovals.values()][0]?.waiters).toBe(0),
        );
        expect(requestSignal?.aborted).toBe(false);
        const retry = invoke();
        await vi.waitFor(() =>
          expect([...nativeHookRelayState.pendingPermissionApprovals.values()][0]?.waiters).toBe(1),
        );
        expect(
          mockCallGatewayTool.mock.calls.filter(
            ([method]) => method === `plugin.approval.${phase}`,
          ),
        ).toHaveLength(1);
        held.resolve({ id: "public-approval", decision: "allow-once" });
        expect(JSON.parse((await retry).stdout).hookSpecificOutput.decision.behavior).toBe("allow");
        expect(nativeHookRelayState.pendingPermissionApprovals.size).toBe(0);
      } finally {
        held.resolve({ id: "public-approval", decision: "deny" });
        controller.abort();
        relay.unregister();
        await Promise.allSettled([first]);
      }
    },
  );

  it.each([false, true])(
    "fences foreground permission results without retiring a retained child (retained: %s)",
    async (retainChild) => {
      const host = await createAdmittedHostCapabilityTestFixture({ runId: "permission-owner" });
      const entered = createDeferredCore<AbortSignal>();
      const decision = createDeferredCore<{ id: string; decision: string }>();
      mockCallGatewayTool.mockImplementation(async (method, _opts, _params, extra) => {
        if (method === "plugin.approval.request") {
          return { id: "approval-1", status: "accepted" };
        }
        if (method !== "plugin.approval.waitDecision" || !extra?.signal) {
          throw new Error("fixture wait missing");
        }
        entered.resolve(extra.signal);
        return await decision.promise;
      });
      let retained = retainChild;
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "permission-owner",
        runId: "permission-owner",
        runBeforeToolCall: host.hostCapabilities.runBeforeToolCall,
        approvalHost: host.hostCapabilities,
        assertActive: host.hostCapabilities.assertActive,
        retention: {
          readClaim: () => "child",
          shouldRetainAfterForegroundClose: () => retained,
          allowPreToolUse: () => true,
          onDispose: () => {},
        },
      });
      await relay.ready;
      const pending = invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
        event: "permission_request",
        rawPayload: { agent_id: "child", tool_name: "fixture", tool_input: {} },
      });
      void pending.catch(() => undefined);
      try {
        const signal = await entered.promise;
        relay.unregister();
        expect(signal.aborted).toBe(true);
        if (retainChild) {
          decision.resolve({ id: "approval-1", decision: "allow-once" });
          await expect(pending).rejects.toThrow("foreground invocation not allowed");
          await expect(
            invokeNativeHookRelay({
              provider: "codex",
              relayId: relay.relayId,
              generation: relay.generation,
              event: "pre_tool_use",
              rawPayload: { agent_id: "child", tool_name: "fixture", tool_input: {} },
            }),
          ).resolves.toMatchObject({ exitCode: 0 });
        } else {
          await expect(pending).rejects.toThrow(/inactive/);
        }
      } finally {
        retained = false;
        relay.unregister();
        decision.resolve({ id: "approval-1", decision: "deny" });
        await Promise.allSettled([pending]);
        await relay.drain();
        host.closeHost();
        host.closeAdmission();
      }
    },
  );

  it.each([
    { phase: "request", cancelAll: false },
    { phase: "waitDecision", cancelAll: false },
    { phase: "request", cancelAll: true },
    { phase: "waitDecision", cancelAll: true },
  ])(
    "owns shared approval $phase work independently of duplicate callers (all cancelled: $cancelAll)",
    async ({ phase, cancelAll }) => {
      const host = await createAdmittedHostCapabilityTestFixture({ runId: "approval-cancel" });
      const held = [
        createDeferredCore<{ id: string; decision: string }>(),
        createDeferredCore<{ id: string; decision: string }>(),
      ];
      const signals: AbortSignal[] = [];
      mockCallGatewayTool.mockImplementation(async (method, _opts, _params, extra) => {
        if (method === `plugin.approval.${phase}`) {
          if (!extra?.signal) {
            throw new Error("fixture shared approval signal missing");
          }
          signals.push(extra.signal);
          // Ignore cancellation deliberately: late transport completion must be harmless.
          return await held[signals.length - 1]!.promise;
        }
        if (method === "plugin.approval.request") {
          return { id: "approval-1", status: "accepted" };
        }
        throw new Error(`unexpected gateway method: ${method}`);
      });
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "approval-cancel",
        runId: "approval-cancel",
        approvalHost: host.hostCapabilities,
      });
      await relay.ready;
      const invoke = (signal?: AbortSignal) =>
        invokeNativeHookRelay(
          {
            provider: "codex",
            relayId: relay.relayId,
            generation: relay.generation,
            event: "permission_request",
            rawPayload: { tool_name: "fixture", tool_use_id: "duplicate-call", tool_input: {} },
          },
          signal,
        );
      const firstAbort = new AbortController();
      const secondAbort = new AbortController();
      const first = invoke(firstAbort.signal);
      const second = invoke(secondAbort.signal);
      void first.catch(() => undefined);
      void second.catch(() => undefined);
      let successor: ReturnType<typeof invoke> | undefined;
      try {
        await vi.waitFor(() =>
          expect([...nativeHookRelayState.pendingPermissionApprovals.values()][0]?.waiters).toBe(2),
        );
        expect(signals).toHaveLength(1);
        expect(signals[0]).not.toBe(firstAbort.signal);
        firstAbort.abort();
        await expect(first).rejects.toThrow(/abort/i);
        expect(signals[0]?.aborted).toBe(false);
        expect(
          mockCallGatewayTool.mock.calls.filter(
            ([method]) => method === `plugin.approval.${phase}`,
          ),
        ).toHaveLength(1);
        if (cancelAll) {
          secondAbort.abort();
          await expect(second).rejects.toThrow(/abort/i);
          await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
          expect(nativeHookRelayState.pendingPermissionApprovals.size).toBe(0);
          successor = invoke();
          await vi.waitFor(() => expect(signals).toHaveLength(2));
          const successorEntry = [...nativeHookRelayState.pendingPermissionApprovals.values()][0];
          held[0]!.resolve({ id: "approval-1", decision: "allow-always" });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect([...nativeHookRelayState.pendingPermissionApprovals.values()][0]).toBe(
            successorEntry,
          );
          expect(nativeHookRelayState.permissionAllowAlwaysApprovals.size).toBe(0);
          expect(signals[1]?.aborted).toBe(false);
          held[1]!.resolve({ id: "approval-1", decision: "deny" });
          expect(JSON.parse((await successor).stdout).hookSpecificOutput.decision.behavior).toBe(
            "deny",
          );
        } else {
          held[0]!.resolve({ id: "approval-1", decision: "allow-once" });
          expect(JSON.parse((await second).stdout).hookSpecificOutput.decision.behavior).toBe(
            "allow",
          );
        }
        expect(nativeHookRelayState.pendingPermissionApprovals.size).toBe(0);
      } finally {
        for (const pending of held) {
          pending.resolve({ id: "approval-1", decision: "deny" });
        }
        firstAbort.abort();
        secondAbort.abort();
        relay.unregister();
        await Promise.allSettled([first, second, successor]);
        await relay.drain();
        host.closeHost();
        host.closeAdmission();
      }
    },
  );

  it("defers all native MCP names to Codex when the exact agent has a prepared durable grant", async () => {
    const grant = { server: "raw-server_", tool: "_raw.tool", source: "allow-always", addedAt: 1 };
    approvalMocks.loadExecApprovalsReadOnly.mockReturnValue({
      version: 1,
      agents: { main: { mcpTools: [grant] }, "*": { mcpTools: [grant] } },
    });
    mockCallGatewayTool.mockResolvedValue({ id: "unexpected-approval", decision: "deny" });
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      agentId: "main",
      sessionId: "session-1",
      runId: "run-1",
    });
    await relay.ready;
    approvalMocks.loadExecApprovalsReadOnly.mockReturnValue({ version: 1, agents: {} });
    for (const toolName of [
      "mcp__raw_server__raw_tool",
      "mcp__hashed_a13e__shortened",
      "mcp__codex_apps__write",
    ]) {
      for (const query of ["first", "different arguments"]) {
        const result = await invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "permission_request",
          rawPayload: {
            hook_event_name: "PermissionRequest",
            tool_name: toolName,
            tool_input: { query },
          },
        });
        expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
      }
    }
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(approvalMocks.loadExecApprovalsReadOnly).toHaveBeenCalledTimes(1);
    relay.unregister();
    approvalMocks.loadExecApprovalsReadOnly.mockReturnValue({
      version: 1,
      agents: { "*": { mcpTools: [grant] } },
    });
    const nextRelay = registerNativeHookRelay({
      provider: "codex",
      agentId: "main",
      sessionId: "session-2",
      runId: "run-2",
    });
    const result = await invokeNativeHookRelay({
      provider: "codex",
      relayId: nextRelay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        tool_name: "mcp__raw_server__raw_tool",
        tool_input: {},
      },
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior).toBe("deny");
  });

  it.each(
    [
      { fullPermission: true, mode: undefined, decision: "defer" },
      { fullPermission: false, mode: undefined, decision: "deny" },
      { fullPermission: false, mode: "approve" as const, decision: "defer" },
      {
        fullPermission: false,
        mode: "prompt" as const,
        nativeServerName: "linear_abc12345",
        decision: "defer",
      },
      { fullPermission: false, mode: "prompt" as const, serverName: "linear_", decision: "defer" },
      {
        fullPermission: false,
        mode: "prompt" as const,
        nativeServerName: "Linear",
        decision: "defer",
      },
    ].map((scenario) => ({
      serverName: scenario.serverName ?? "linear",
      nativeServerName: scenario.nativeServerName ?? "linear",
      fullPermission: scenario.fullPermission,
      mode: scenario.mode,
      decision: scenario.decision,
    })),
  )(
    "uses full=$fullPermission with server $serverName mode=$mode for MCP approval",
    async ({ fullPermission, mode, decision, serverName, nativeServerName }) => {
      mockCallGatewayTool.mockResolvedValue({ id: "approval-1", decision: "deny" });
      const registration = {
        provider: "codex" as const,
        sessionId: "session-1",
        runId: "run-1",
        autoApproveMcpTools: fullPermission,
        config: {
          mcp: {
            servers: {
              [serverName]: {
                url: "https://mcp.example.test",
                codex: { defaultToolsApprovalMode: mode },
              },
            },
          },
        },
      };
      const relay = registerNativeHookRelay(registration);
      const result = await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: `mcp__${nativeServerName}__list_issues`,
          tool_input: { query: "first" },
        },
      });

      if (decision === "defer") {
        expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
      } else {
        expect(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior).toBe(decision);
      }
      expect(mockCallGatewayTool).toHaveBeenCalledTimes(decision === "defer" ? 0 : 1);
    },
  );

  it.each([null, "deny"])("explains how to unblock an MCP tool after %s", async (decision) => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-timeout", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-timeout", decision });
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    const result = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        tool_name: "mcp__memory__create_entities",
        tool_input: { entities: [] },
      },
    });

    expect(result.stdout).toContain(
      decision === null ? "MCP tool approval timed out" : "Denied by user",
    );
    expect(result.stdout).toContain("openclaw mcp configure memory --approval approve");
  });

  it.each(["arguments", "cwd", "elapsed time", "shortened name", "tool", "server", "case"])(
    "scopes MCP allow-always after changed %s",
    async (change) => {
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "approval-1", decision: "allow-always" })
        .mockResolvedValueOnce({ id: "approval-2", decision: "deny" });
      const now = Date.now();
      const relay = registerNativeHookRelay({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        ttlMs: 60 * 60_000,
      });
      const invoke = (cwd: string, query: string, toolName = "mcp__linear__list_issues") =>
        invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "permission_request",
          rawPayload: {
            hook_event_name: "PermissionRequest",
            cwd,
            tool_name: toolName,
            tool_input: { query },
          },
        });
      const initialToolName = change === "shortened name" ? "mcp__list_issues" : undefined;
      await invoke("/repo", "first", initialToolName);
      if (change === "elapsed time" || change === "shortened name") {
        vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
      }
      const result = await invoke(
        change === "cwd" ? "/other-repo" : "/repo",
        change === "arguments" ? "second" : "first",
        change === "tool"
          ? "mcp__linear__get_issue"
          : change === "case"
            ? "mcp__linear__List_Issues"
            : change === "server"
              ? "mcp__other__list_issues"
              : initialToolName,
      );

      const sameTool = change !== "tool" && change !== "server" && change !== "case";
      expect(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior).toBe(
        sameTool ? "allow" : "deny",
      );
      expect(mockCallGatewayTool).toHaveBeenCalledTimes(sameTool ? 1 : 2);
    },
  );

  it.each(["unregister", "replace"])("forgets MCP allow-always on relay %s", async (disposal) => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1", decision: "allow-always" })
      .mockResolvedValueOnce({ id: "approval-2", decision: "deny" });
    const registration = {
      provider: "codex" as const,
      relayId: "mcp-approval-lifetime",
      sessionId: "session-1",
      runId: "run-1",
    };
    const relay = registerNativeHookRelay(registration);
    const invoke = () =>
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "mcp__linear__list_issues",
          tool_input: { query: "first" },
        },
      });
    await invoke();
    if (disposal === "unregister") {
      relay.unregister();
    }
    registerNativeHookRelay({ ...registration, runId: "run-2" });
    const result = await invoke();

    expect(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior).toBe("deny");
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(2);
  });

  it("defers an MCP tool when no approval id is created", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ status: "unavailable" });
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "mcp__memory__create_entities",
          tool_input: { entities: [] },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
  });

  it("defers an MCP tool when waitDecision returns a different approval id", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-request", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:other-approval", decision: null });
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "mcp__memory__create_entities",
          tool_input: { entities: [] },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("defers when waitDecision reports a stale approval id", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-stale", status: "accepted" })
      .mockRejectedValueOnce(new Error("approval expired or not found"));
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "cat /tmp/private-key" },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });
});
