import fs from "node:fs/promises";
import path from "node:path";
import { reviewExecRequestWithConfiguredModel } from "openclaw/plugin-sdk/agent-harness-exec-review-runtime";
import {
  callGatewayTool,
  hasNativeHookRelayInvocation,
  invokeNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
  runBeforeToolCallHook,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { prepareSystemRunMutableFileApproval } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import { codexTestTurnIds } from "./codex-app-server.test-fixtures.js";
import { waitForPluginApprovalDecision } from "./plugin-approval-roundtrip.js";
import type { JsonObject } from "./protocol.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: vi.fn(),
  hasNativeHookRelayInvocation: vi.fn(() => false),
  invokeNativeHookRelay: vi.fn(),
  resolveNativeHookRelayDeferredToolApproval: vi.fn(),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-exec-review-runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("openclaw/plugin-sdk/agent-harness-exec-review-runtime")
  >()),
  reviewExecRequestWithConfiguredModel: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const mockHasNativeHookRelayInvocation = vi.mocked(hasNativeHookRelayInvocation);
const mockInvokeNativeHookRelay = vi.mocked(invokeNativeHookRelay);
const mockResolveNativeHookRelayDeferredToolApproval = vi.mocked(
  resolveNativeHookRelayDeferredToolApproval,
);
const mockReviewExecRequestWithConfiguredModel = vi.mocked(reviewExecRequestWithConfiguredModel);
const mockRunBeforeToolCallHook = vi.mocked(runBeforeToolCallHook);

const requireRecord = createRequireRecord("record", "expected-label-capitalized");
type AgentHarnessHostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];

const prepareApprovalWithoutMutableFile: AgentHarnessHostCapabilities["prepareMutableFileApproval"] =
  async () => ({
    ok: true,
    requiresOneShot: false,
    revalidate: async () => ({ ok: true }),
  });

function gatewayRequestPayload() {
  return requireRecord(mockCallGatewayTool.mock.calls[0]?.[2], "gateway request payload");
}

function findApprovalEvent(
  params: ReturnType<typeof createParams>,
  fields: Partial<Record<"status" | "approvalId" | "command" | "reason" | "message", string>>,
) {
  for (const [event] of params.onAgentEvent.mock.calls) {
    if (
      event.stream === "approval" &&
      Object.entries(fields).every(([key, value]) => event.data[key] === value)
    ) {
      return event.data;
    }
  }
  throw new Error(`Expected approval event ${JSON.stringify(fields)}`);
}

function mockApprovalDecision(id: string, decision: "allow-once" | "allow-always" | "deny") {
  mockCallGatewayTool
    .mockResolvedValueOnce({ id, status: "accepted" })
    .mockResolvedValueOnce({ id, decision });
}

type ApprovalRequest = Parameters<typeof handleCodexAppServerApprovalRequest>[0];
const nativeHookRelay: NonNullable<ApprovalRequest["nativeHookRelay"]> = {
  relayId: "relay-1",
  generation: "generation-1",
  allowedEvents: ["pre_tool_use"],
};

function requestNativeApproval(
  paramsForRun: EmbeddedRunAttemptParams,
  requestParams: JsonObject,
  options: Omit<
    ApprovalRequest,
    "threadId" | "turnId" | "requestParams" | "paramsForRun" | "method"
  > & { method?: string } = {},
) {
  return handleCodexAppServerApprovalRequest({
    method: "item/commandExecution/requestApproval",
    ...codexTestTurnIds(),
    ...options,
    paramsForRun,
    requestParams: { ...codexTestTurnIds(), ...requestParams },
  });
}

function createParams() {
  const onAgentEvent = vi.fn<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>();
  const params = {
    sessionKey: "agent:main:session-1",
    agentId: "main",
    onAgentEvent,
  } as unknown as EmbeddedRunAttemptParams;
  const hostCapabilities: AgentHarnessHostCapabilities = {
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    bindToolSurface: (tools) => tools,
    prepareMutableFileApproval: prepareSystemRunMutableFileApproval,
    runBeforeToolCall: async ({ approvalMode = "request", ...request }) =>
      runBeforeToolCallHook({
        ...request,
        approvalMode,
        ctx: { agentId: params.agentId, sessionKey: params.sessionKey },
      }),
    requestApproval: async (request) =>
      (await callGatewayTool(
        "plugin.approval.request",
        { timeoutMs: request.timeoutMs },
        {
          pluginId: "codex",
          ...request,
          timeoutMs: 120_000,
          twoPhase: true,
        },
        { expectFinal: false },
      )) as Awaited<ReturnType<AgentHarnessHostCapabilities["requestApproval"]>>,
    waitForApproval: async (request) => {
      const result = (await callGatewayTool(
        "plugin.approval.waitDecision",
        { timeoutMs: request.timeoutMs },
        { id: request.approvalId },
      )) as { id?: string } & Partial<
        NonNullable<Awaited<ReturnType<AgentHarnessHostCapabilities["waitForApproval"]>>>
      >;
      return result?.id === request.approvalId
        ? { decision: result.decision, terminalReason: result.terminalReason }
        : undefined;
    },
  };
  return Object.assign(params, { hostCapabilities, onAgentEvent });
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
async function createScript() {
  const tempDir = tempDirs.make("openclaw-codex-script-");
  const scriptPath = path.join(tempDir, "script.sh");
  await fs.writeFile(scriptPath, "#!/bin/sh\necho approved\n");
  return { tempDir, scriptPath };
}

function configureExecReviewer(params: EmbeddedRunAttemptParams) {
  params.config = {
    tools: {
      exec: { mode: "auto", reviewer: { model: "openai/gpt-5.5-mini" } },
    },
  } as EmbeddedRunAttemptParams["config"];
}

describe("Codex app-server approval bridge", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
    mockHasNativeHookRelayInvocation.mockReset().mockReturnValue(false);
    mockInvokeNativeHookRelay.mockReset();
    mockResolveNativeHookRelayDeferredToolApproval.mockReset().mockResolvedValue(undefined);
    mockReviewExecRequestWithConfiguredModel.mockReset();
    mockRunBeforeToolCallHook.mockReset().mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  it("cancels native approval when permissions change during final file revalidation", async () => {
    const params = createParams();
    const controller = new AbortController();
    const onNativeToolFailureDisposition = vi.fn();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: async () => ({
        ok: true,
        requiresOneShot: false,
        revalidate: async () => {
          controller.abort("permission-change");
          return { ok: true };
        },
      }),
    };

    const result = await requestNativeApproval(
      params,
      {
        itemId: "cmd-permission-change",
        command: "node script.js",
      },
      { autoApprove: true, signal: controller.signal, onNativeToolFailureDisposition },
    );

    expect(result).toEqual({ decision: "cancel" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith(
      "cmd-permission-change",
      "cancelled",
    );
    expect(params.onAgentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "approved" }) }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("denies command approval when a script operand changes before the decision", async () => {
    const { tempDir, scriptPath } = await createScript();
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:script-drift", status: "accepted" })
      .mockImplementationOnce(async () => {
        await fs.writeFile(scriptPath, "#!/bin/sh\necho mutated\n");
        return { id: "plugin:script-drift", decision: "allow-once" };
      });
    const result = await requestNativeApproval(params, {
      itemId: "cmd-script-drift",
      command: `sh ${scriptPath}`,
      cwd: tempDir,
    });
    expect(result).toEqual({ decision: "decline" });
    findApprovalEvent(params, {
      status: "denied",
      approvalId: "plugin:script-drift",
      message: "SYSTEM_RUN_DENIED: approval script operand changed before execution",
    });
  });

  it("keeps approval of an unchanged byte-bound script one-shot", async () => {
    const { tempDir, scriptPath } = await createScript();
    const params = createParams();
    mockApprovalDecision("plugin:script-stable", "allow-always");
    const result = await requestNativeApproval(params, {
      itemId: "cmd-script-stable",
      command: `sh ${scriptPath}`,
      cwd: tempDir,
      availableDecisions: ["accept", "acceptForSession", "cancel"],
    });
    expect(result).toEqual({ decision: "accept" });
    expect(gatewayRequestPayload().allowedDecisions).toEqual(["allow-once", "deny"]);
    findApprovalEvent(params, {
      status: "approved",
      approvalId: "plugin:script-stable",
      message: "Codex app-server approval granted for this byte-bound command only.",
    });
  });

  it("requires the final human decision for execve approvals even with auto-review configured", async () => {
    const params = createParams();
    configureExecReviewer(params);
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "read-only version check",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-auto-review", decision: "allow-always" })
      .mockResolvedValueOnce({ id: "plugin:approval-auto-review", decision: "deny" });

    const result = await requestNativeApproval(params, {
      itemId: "cmd-auto-review",
      approvalId: "execve-approval-1",
      availableDecisions: ["accept", "cancel"],
      command: "node --version",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, { status: "denied", approvalId: "plugin:approval-auto-review" });
  });

  it("keeps commandless managed-network approvals on the human route in full-auto", async () => {
    const params = createParams();
    mockApprovalDecision("plugin:approval-network", "allow-once");

    const result = await requestNativeApproval(
      params,
      {
        itemId: "cmd-auto-review-network",
        networkApprovalContext: {
          host: "example.test",
          protocol: "https",
        },
      },
      { autoApprove: true },
    );

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(gatewayRequestPayload()).toMatchObject({
      title: "Codex app-server network approval",
      description: "Network: https://example.test",
      toolName: "codex_network_approval",
    });
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "codex_network_approval",
        params: expect.objectContaining({
          approval: expect.objectContaining({
            networkApprovalContext: { host: "example.test", protocol: "https" },
          }),
        }),
      }),
    );
  });

  it("passes the exact native command cwd to the host policy capability", async () => {
    const params = createParams();
    params.cwd = "/attempt/worktree";
    const runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"] = vi.fn(
      async ({ params: toolParams }) => ({
        blocked: true as const,
        kind: "veto" as const,
        deniedReason: "plugin-before-tool-call" as const,
        reason: "blocked by policy",
        params: toolParams,
      }),
    );
    params.hostCapabilities = { ...params.hostCapabilities, runBeforeToolCall };

    const result = await requestNativeApproval(params, {
      itemId: "cmd-native-cwd",
      command: "pwd",
      cwd: "/native/action/worktree",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(runBeforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ nativeOperation: { cwd: "/native/action/worktree" } }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "policy denial",
      stdout: JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "blocked by native relay",
        },
      }),
      stderr: "",
      exitCode: 0,
      message: "blocked by native relay",
    },
    {
      label: "unreadable output",
      stdout: "not-json",
      stderr: "",
      exitCode: 0,
      message:
        "OpenClaw native hook relay returned an unreadable Codex app-server approval result.",
    },
    {
      label: "non-deny output",
      stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }),
      stderr: "",
      exitCode: 0,
      message: "OpenClaw native hook relay returned a non-deny Codex app-server approval decision.",
    },
    {
      label: "non-zero exit",
      stdout: "ignored stdout",
      stderr: "blocked from stderr",
      exitCode: 1,
      message: "blocked from stderr",
    },
  ])(
    "fails closed on native relay $label before prompting",
    async ({ stdout, stderr, exitCode, message }) => {
      const params = createParams();
      mockInvokeNativeHookRelay.mockResolvedValueOnce({ stdout, stderr, exitCode });
      const requestParams = {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay",
        command: "cat /tmp/private_key",
        cwd: "/workspace",
      };
      const result = await requestNativeApproval(params, requestParams, {
        autoApprove: true,
        nativeHookRelay,
      });
      expect(result).toEqual({ decision: "decline" });
      expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
      expect(mockInvokeNativeHookRelay).toHaveBeenCalledExactlyOnceWith({
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          openclaw_approval_mode: "report",
          tool_name: "exec_command",
          tool_use_id: "cmd-native-relay",
          cwd: "/workspace",
          turn_id: "turn-1",
          tool_input: {
            command: requestParams.command,
            cwd: "/workspace",
            approval: requestParams,
            cmd: requestParams.command,
          },
        },
        requireGeneration: true,
      });
      findApprovalEvent(params, { status: "denied", message });
    },
  );

  it.each(["invocation", "deferred"] as const)(
    "fails closed when host authority closes during native relay %s",
    async (phase) => {
      const params = createParams();
      let active = true;
      params.hostCapabilities = {
        ...params.hostCapabilities,
        assertActive: () => {
          if (!active) {
            throw new Error("agent harness host capability is no longer active");
          }
        },
      };
      mockHasNativeHookRelayInvocation
        .mockReturnValueOnce(phase === "deferred")
        .mockReturnValueOnce(true);
      mockInvokeNativeHookRelay.mockImplementationOnce(async () => {
        active = false;
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      mockResolveNativeHookRelayDeferredToolApproval.mockImplementationOnce(async () => {
        active = false;
        return { handled: true, outcome: "approved-once" };
      });
      const result = await requestNativeApproval(
        params,
        { itemId: "cmd-native-relay-late", command: "git status" },
        { autoApprove: true, nativeHookRelay },
      );
      expect(result).toEqual({ decision: "decline" });
      expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
      findApprovalEvent(params, { status: phase === "invocation" ? "denied" : "unavailable" });
    },
  );

  it("correlates distinct execve approvals by approvalId instead of parent itemId", async () => {
    const params = createParams();
    const seenToolUseIds = new Set<string>();
    mockHasNativeHookRelayInvocation.mockImplementation(({ toolUseId }) =>
      toolUseId ? seenToolUseIds.has(toolUseId) : false,
    );
    mockInvokeNativeHookRelay.mockImplementation(async ({ rawPayload }) => {
      const toolUseId = requireRecord(rawPayload, "native relay payload").tool_use_id;
      if (typeof toolUseId === "string") {
        seenToolUseIds.add(toolUseId);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-execve-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-execve-1", decision: "allow-once" })
      .mockResolvedValueOnce({ id: "plugin:approval-execve-2", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-execve-2", decision: "allow-once" });

    for (const [approvalId, command] of [
      ["execve-approval-1", "git status"],
      ["execve-approval-2", "rm -rf /tmp/work"],
    ] as const) {
      const result = await requestNativeApproval(
        params,
        {
          itemId: "parent-command-item",
          approvalId,
          command,
          cwd: "/workspace",
        },
        { nativeHookRelay },
      );
      expect(result).toEqual({ decision: "accept" });
    }

    expect(mockCallGatewayTool).toHaveBeenCalledTimes(4);
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    findApprovalEvent(params, { status: "pending", approvalId: "plugin:approval-execve-2" });
    findApprovalEvent(params, { status: "approved", approvalId: "plugin:approval-execve-2" });
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(2);
    expect(
      mockInvokeNativeHookRelay.mock.calls.map(
        ([call]) => requireRecord(call.rawPayload, "native relay payload").tool_use_id,
      ),
    ).toEqual(["execve-approval-1", "execve-approval-2"]);
    expect(mockHasNativeHookRelayInvocation).toHaveBeenNthCalledWith(1, {
      relayId: "relay-1",
      event: "pre_tool_use",
      toolUseId: "execve-approval-1",
    });
    expect(mockHasNativeHookRelayInvocation).toHaveBeenNthCalledWith(2, {
      relayId: "relay-1",
      event: "pre_tool_use",
      toolUseId: "execve-approval-2",
    });
  });

  it("accepts command approvals from deferred native PreToolUse plugin approvals", async () => {
    const params = createParams();
    mockHasNativeHookRelayInvocation.mockReturnValueOnce(true);
    mockResolveNativeHookRelayDeferredToolApproval.mockResolvedValueOnce({
      handled: true,
      outcome: "approved-once",
    });

    const result = await requestNativeApproval(
      params,
      {
        itemId: "cmd-native-relay-deferred",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      {
        nativeHookRelay,
      },
    );

    expect(result).toEqual({ decision: "accept" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).not.toHaveBeenCalled();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "approved",
      message: "Codex app-server approval granted for this turn.",
    });
  });

  it("preserves a deferred native approval failure for lifecycle projection", async () => {
    const params = createParams();
    const onNativeToolFailureDisposition = vi.fn();
    mockHasNativeHookRelayInvocation.mockReturnValueOnce(true);
    mockResolveNativeHookRelayDeferredToolApproval.mockResolvedValueOnce({
      handled: true,
      outcome: "denied",
      reason: "Approval cancelled because the run stopped",
      failureDisposition: "cancelled",
    });

    const result = await requestNativeApproval(
      params,
      {
        itemId: "cmd-native-relay-deferred-failure",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      {
        nativeHookRelay,
        onNativeToolFailureDisposition,
      },
    );

    expect(result).toEqual({ decision: "decline" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith(
      "cmd-native-relay-deferred-failure",
      "cancelled",
    );
  });

  it.each([
    {
      autoApprove: false,
      decision: "decline",
      status: "denied",
      message:
        "OpenClaw native hook relay unavailable for Codex app-server approval: native hook relay not found",
    },
    {
      autoApprove: true,
      decision: "accept",
      status: "approved",
      message: "Codex app-server approval auto-approved by runtime policy.",
    },
  ])(
    "handles an unavailable relay under autoApprove=$autoApprove",
    async ({ autoApprove, decision, status, message }) => {
      const params = createParams();
      mockInvokeNativeHookRelay.mockRejectedValueOnce(new Error("native hook relay not found"));
      const result = await requestNativeApproval(
        params,
        { itemId: "cmd-native-relay-missing", command: "pwd" },
        { autoApprove, nativeHookRelay },
      );
      expect(result).toEqual({ decision });
      expect(mockRunBeforeToolCallHook).toHaveBeenCalledTimes(autoApprove ? 1 : 0);
      expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
      findApprovalEvent(params, { status, message });
    },
  );

  it("denies permission grants through the human route even with a native relay", async () => {
    const params = createParams();
    mockApprovalDecision("plugin:permission-approval", "deny");
    const result = await requestNativeApproval(
      params,
      {
        itemId: "permission-native-relay-registered",
        permissions: { network: { allowHosts: ["example.com"] } },
      },
      {
        method: "item/permissions/requestApproval",
        nativeHookRelay,
      },
    );
    expect(result).toEqual({ permissions: {}, scope: "turn" });
    expect(mockInvokeNativeHookRelay).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("denies command approvals when OpenClaw tool policy rewrites params", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: false,
      params: {
        command: "echo rewritten",
        approval: {
          ...codexTestTurnIds(),
          itemId: "cmd-rewritten",
          command: "echo rewritten",
        },
      },
    });

    const result = await requestNativeApproval(params, {
      itemId: "cmd-rewritten",
      command: "cat /tmp/private_key",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
    });
  });

  it("keeps OpenClaw plugin allow-always approvals scoped to one Codex request", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: false,
      params: {
        command: "pnpm test",
        approval: {
          ...codexTestTurnIds(),
          itemId: "cmd-needs-approval",
          command: "pnpm test",
        },
      },
      approvalResolution: "allow-always",
    });

    const result = await requestNativeApproval(params, {
      itemId: "cmd-needs-approval",
      command: "pnpm test",
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "approved",
      message: "Codex app-server approval granted for this turn.",
    });
  });

  it("preserves a pre-execution failure for native lifecycle projection", async () => {
    const disposition = "failed" as const;
    const params = createParams();
    const onNativeToolFailureDisposition = vi.fn();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: true,
      kind: "failure",
      disposition,
      deniedReason: "plugin-before-tool-call",
      reason: "Tool call blocked because before_tool_call hook failed",
    });

    const result = await requestNativeApproval(
      params,
      {
        itemId: "cmd-policy-failure",
        command: "pnpm test",
      },
      { onNativeToolFailureDisposition },
    );

    expect(result).toEqual({ decision: "decline" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("cmd-policy-failure", disposition);
  });

  it("describes command approval permission and policy amendments", async () => {
    const params = createParams();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: prepareApprovalWithoutMutableFile,
    };
    mockApprovalDecision("plugin:approval-command-permissions", "allow-always");

    const result = await requestNativeApproval(params, {
      itemId: "cmd-permissions",
      command: "npm install",
      commandActions: [{ command: `${"npm install ".repeat(500)} --unsafe-perm` }],
      additionalPermissions: {
        fileSystem: {
          write: ["/"],
        },
      },
      proposedExecpolicyAmendment: ["npm install"],
      proposedNetworkPolicyAmendments: [{ host: "registry.npmjs.org", action: "allow" }],
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("Command: npm install");
    expect(description).toContain("[preview truncated or unsafe content omitted]");
    expect(findApprovalEvent(params, {}).commandPreviewOmitted).toBe(true);
    expect(description).toContain("Additional permissions: fileSystem");
    expect(description).toContain("High-risk targets: filesystem root");
    expect(description).toContain("File system write: /");
    expect(description).toContain("Proposed exec policy: npm install");
    expect(description).toContain("Proposed network policy: allow registry.npmjs.org");
  });

  it("sanitizes parsed command previews without changing the policy command", async () => {
    const params = createParams();
    mockApprovalDecision("plugin:approval-sanitized-command", "allow-once");
    const esc = "\u001b";
    const preview = `pnpm\n${esc}[31mtest${esc}[0m ${esc}]8;;https://example.com${esc}\\VISIBLE${esc}]8;;${esc}\\ safe\u202e hidden\u2069 \ufeffdone\u{e0100} <@U123> [trusted](https://evil) @here`;
    const visible =
      "pnpm test VISIBLE safe hidden done &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here";

    await requestNativeApproval(params, {
      itemId: "cmd-sanitized",
      command: "printf safe",
      commandActions: [{ command: preview }],
    });

    expect(gatewayRequestPayload().description).toBe(`Command: ${visible}`);
    expect(mockRunBeforeToolCallHook.mock.calls[0]?.[0]).toMatchObject({
      toolName: "exec",
      params: { command: "printf safe" },
    });
    findApprovalEvent(params, { status: "pending", command: visible });
  });

  it("fails closed when no approval route is available", async () => {
    const params = createParams();
    const onNativeToolFailureDisposition = vi.fn();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-2",
      decision: null,
    });

    const result = await requestNativeApproval(
      params,
      {
        itemId: "patch-1",
        reason: "needs write access\nfor \u001b[31m/tmp\u001b[0m\tplease",
      },
      { method: "item/fileChange/requestApproval", onNativeToolFailureDisposition },
    );

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("patch-1", "failed");
    expect(gatewayRequestPayload().description).toBe("Reason: needs write access for /tmp please");
    findApprovalEvent(params, {
      status: "unavailable",
      reason: "needs write access for /tmp please",
    });
  });

  it("fails closed when waitDecision reports a stale approval id", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-stale", status: "accepted" })
      .mockRejectedValueOnce(new Error("approval expired or not found"));

    const result = await requestNativeApproval(
      params,
      {
        itemId: "patch-stale",
        reason: "needs write access",
      },
      { method: "item/fileChange/requestApproval" },
    );

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, {
      status: "unavailable",
      approvalId: "plugin:approval-stale",
      reason: "needs write access",
      message: "Codex app-server approval unavailable.",
    });
  });

  it("does not classify a matching abort reason as a stale gateway wait", async () => {
    const controller = new AbortController();
    mockCallGatewayTool.mockImplementationOnce(() => new Promise(() => {}));

    const pending = waitForPluginApprovalDecision({
      hostCapabilities: createParams().hostCapabilities,
      approvalId: "plugin:approval-abort",
      signal: controller.signal,
    });
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();
    controller.abort(new Error("approval expired or not found"));

    await expect(pending).rejects.toThrow("approval expired or not found");
  });

  it("uses the gateway terminal reason as the authoritative approval timeout", async () => {
    const params = createParams();
    const onNativeToolFailureDisposition = vi.fn();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-expired", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-expired",
        decision: "deny",
        terminalReason: "timeout",
      });

    const result = await requestNativeApproval(
      params,
      {
        itemId: "cmd-expired",
        command: "pnpm test",
        availableDecisions: ["accept", "cancel"],
      },
      { onNativeToolFailureDisposition },
    );

    expect(result).toEqual({ decision: "decline" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith(
      "cmd-expired",
      "timed_out",
      "command",
    );
    findApprovalEvent(params, {
      status: "denied",
      approvalId: "plugin:approval-expired",
      message: "Command approval timed out before an operator responded.",
    });
  });

  it("routes unknown approval methods to the human path and still fails closed", async () => {
    const params = createParams();
    mockApprovalDecision("plugin:future-approval", "deny");

    const result = await requestNativeApproval(
      params,
      {
        itemId: "future-1",
      },
      { method: "future/requestApproval" },
    );

    expect(result).toEqual({
      decision: "decline",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, {
      status: "denied",
      approvalId: "plugin:future-approval",
    });
  });
  it("shows bounded, sanitized permission targets and requires human approval in full-auto", async () => {
    const params = createParams();
    mockApprovalDecision("plugin:approval-current-permissions", "allow-once");
    const permissions = {
      network: {
        enabled: true,
        allowHosts: [
          "https://secret-token@exa\u009b31mmple.com/private",
          "*.internal",
          "third.example.com",
        ],
      },
      fileSystem: {
        read: ["/Users/simone/.ssh/id_rsa"],
        write: ["/"],
        roots: ["/tmp/\u001b[31mproject\u001b[0m"],
        readPaths: ["/etc/hosts", "/var/log/system.log"],
        writePaths: ["/tmp/output", "/home/simone/private", "/var/log/app"],
        entries: [
          { path: "/workspace/project", access: "read" },
          { path: "/tmp/output", access: "write" },
          { path: "/ignored", access: "none" },
        ],
      },
    };
    const expectedPermissions = structuredClone(permissions);
    const result = await requestNativeApproval(
      params,
      { itemId: "perm-current", permissions },
      { method: "item/permissions/requestApproval", autoApprove: true },
    );
    expect(result).toEqual({ permissions: expectedPermissions, scope: "turn" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "codex_permission_approval" }),
    );
    const description = String(gatewayRequestPayload().description);
    expect(description.length).toBeLessThanOrEqual(700);
    expect(description).toContain(
      "Network enabled: true; allowHosts: example.com, *.internal (+1 more)",
    );
    expect(description).toContain("File system read: ~/.ssh/id_rsa; write: /; roots: /tmp/project");
    expect(description).toContain("entries: read /workspace/project, write /tmp/output (+1 more)");
    expect(description).toContain(
      "High-risk targets: network access, wildcard hosts, private-network wildcards, filesystem root",
    );
    expect(description).not.toMatch(/secret-token|simone/);
    expect(description).not.toContain("\u009b");
    expect(description).not.toContain("\u001b");
  });

  it("ignores approval requests that are missing explicit thread or turn ids", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      ...codexTestTurnIds(),
      method: "item/commandExecution/requestApproval",
      requestParams: {
        itemId: "cmd-2",
        command: "pnpm test",
      },
      paramsForRun: params,
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(params.onAgentEvent).not.toHaveBeenCalled();
  });

  it("does not expose split surrogate pairs from the command array preview scan cap", async () => {
    const params = createParams();
    mockApprovalDecision("plugin:approval-utf16-scan", "allow-once");

    await requestNativeApproval(params, {
      itemId: "cmd-utf16-scan",
      command: [`${"\u0000".repeat(4095)}😀tail`],
    });

    const event = findApprovalEvent(params, { status: "denied" });
    expect(event.commandPreviewOmitted).toBe(true);
    expect(event.command).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(() => encodeURIComponent(JSON.stringify(event))).not.toThrow();
  });
});
