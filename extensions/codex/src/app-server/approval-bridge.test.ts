import fs from "node:fs/promises";
import path from "node:path";
import { reviewExecRequestWithConfiguredModel } from "openclaw/plugin-sdk/agent-harness-exec-review-runtime";
import {
  embeddedAgentLog,
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
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { waitForPluginApprovalDecision } from "./plugin-approval-roundtrip.js";
import type { JsonObject } from "./protocol.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
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

const hasRelayInvocation = vi.mocked(hasNativeHookRelayInvocation);
const invokeRelay = vi.mocked(invokeNativeHookRelay);
const resolveDeferred = vi.mocked(resolveNativeHookRelayDeferredToolApproval);
const reviewExec = vi.mocked(reviewExecRequestWithConfiguredModel);
const beforeToolCall = vi.mocked(runBeforeToolCallHook);

const requireRecord = createRequireRecord("record", "expected-label-capitalized");
type AgentHarnessHostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];
const requestApproval = vi.fn<AgentHarnessHostCapabilities["requestApproval"]>();
const waitForApproval = vi.fn<AgentHarnessHostCapabilities["waitForApproval"]>();

const noMutableFile: AgentHarnessHostCapabilities["prepareMutableFileApproval"] = async () => ({
  ok: true,
  requiresOneShot: false,
  revalidate: async () => ({ ok: true }),
});

function gatewayRequestPayload() {
  return requireRecord(requestApproval.mock.calls[0]?.[0], "host approval request");
}

function approvalEvent(
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

function expectHumanApproval() {
  expect(requestApproval).toHaveBeenCalledOnce();
  expect(waitForApproval).toHaveBeenCalledOnce();
}

function expectNoHumanApproval() {
  expect(requestApproval).not.toHaveBeenCalled();
  expect(waitForApproval).not.toHaveBeenCalled();
}

function expectPolicy(fields: Record<string, unknown>) {
  expect(beforeToolCall).toHaveBeenCalledWith(expect.objectContaining(fields));
}

function expectDescription(...parts: string[]) {
  for (const part of parts) {
    expect(String(gatewayRequestPayload().description)).toContain(part);
  }
}

function mockApprovalDecision(id: string, decision: "allow-once" | "allow-always" | "deny") {
  requestApproval.mockResolvedValueOnce({ id });
  waitForApproval.mockResolvedValueOnce({ decision, terminalReason: undefined });
}

type ApprovalRequest = Parameters<typeof handleCodexAppServerApprovalRequest>[0];
const nativeHookRelay: NonNullable<ApprovalRequest["nativeHookRelay"]> = {
  relayId: "relay-1",
  generation: "generation-1",
  allowedEvents: ["pre_tool_use"],
};

function approve(
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
    paramsForRun: params,
    requestParams: { ...codexTestTurnIds(), itemId: "cmd", ...requestParams },
  });
}

function createParams(overrides: Partial<AgentHarnessHostCapabilities> = {}) {
  const onAgentEvent = vi.fn<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>();
  const params = {
    sessionKey: "agent:main:session-1",
    agentId: "main",
    onAgentEvent,
  } as unknown as EmbeddedRunAttemptParams;
  const hostCapabilities = createCodexTestHostCapabilities({
    prepareMutableFileApproval: prepareSystemRunMutableFileApproval,
    runBeforeToolCall: async ({ approvalMode = "request", ...request }) =>
      runBeforeToolCallHook({
        ...request,
        approvalMode,
        ctx: { agentId: params.agentId, sessionKey: params.sessionKey },
      }),
    requestApproval,
    waitForApproval,
    ...overrides,
  });
  return Object.assign(params, { hostCapabilities, onAgentEvent });
}

let params: ReturnType<typeof createParams>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
async function createScript() {
  const tempDir = tempDirs.make("openclaw-codex-script-");
  const scriptPath = path.join(tempDir, "script.sh");
  await fs.writeFile(scriptPath, "#!/bin/sh\necho approved\n");
  return { tempDir, scriptPath };
}

function configureExecReviewer(run: EmbeddedRunAttemptParams) {
  run.config = {
    tools: {
      exec: { mode: "auto", reviewer: { model: "openai/gpt-5.5-mini" } },
    },
  } as EmbeddedRunAttemptParams["config"];
}

describe("Codex app-server approval bridge", () => {
  beforeEach(() => {
    params = createParams();
    requestApproval.mockReset();
    waitForApproval.mockReset();
    hasRelayInvocation.mockReset().mockReturnValue(false);
    invokeRelay.mockReset();
    resolveDeferred.mockReset().mockResolvedValue(undefined);
    reviewExec.mockReset();
    beforeToolCall.mockReset().mockImplementation(async ({ params: toolParams }) => ({
      blocked: false,
      params: toolParams,
    }));
  });

  it("cancels native approval when permissions change during final file revalidation", async () => {
    const controller = new AbortController();
    const onNativeToolFailureDisposition = vi.fn();
    params = createParams({
      prepareMutableFileApproval: async () => ({
        ok: true,
        requiresOneShot: false,
        revalidate: async () => {
          controller.abort("permission-change");
          return { ok: true };
        },
      }),
    });
    const result = await approve(
      { command: "node script.js" },
      { autoApprove: true, signal: controller.signal, onNativeToolFailureDisposition },
    );
    expect(result).toEqual({ decision: "cancel" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("cmd", "cancelled");
    expect(params.onAgentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "approved" }) }),
    );
    expectNoHumanApproval();
  });

  it("denies command approval when a script operand changes before the decision", async () => {
    const { tempDir, scriptPath } = await createScript();
    requestApproval.mockResolvedValueOnce({ id: "plugin:script-drift" });
    waitForApproval.mockImplementationOnce(async () => {
      await fs.writeFile(scriptPath, "#!/bin/sh\necho mutated\n");
      return { decision: "allow-once", terminalReason: undefined };
    });
    const result = await approve({
      command: `sh ${scriptPath}`,
      cwd: tempDir,
    });
    expect(result).toEqual({ decision: "decline" });
    approvalEvent(params, {
      status: "denied",
      approvalId: "plugin:script-drift",
      message: "SYSTEM_RUN_DENIED: approval script operand changed before execution",
    });
  });

  it("keeps approval of an unchanged byte-bound script one-shot", async () => {
    const { tempDir, scriptPath } = await createScript();
    mockApprovalDecision("plugin:script-stable", "allow-always");
    const result = await approve({
      command: `sh ${scriptPath}`,
      cwd: tempDir,
      availableDecisions: ["accept", "acceptForSession", "cancel"],
    });
    expect(result).toEqual({ decision: "accept" });
    expect(gatewayRequestPayload().allowedDecisions).toEqual(["allow-once", "deny"]);
    approvalEvent(params, {
      status: "approved",
      approvalId: "plugin:script-stable",
      message: "Codex app-server approval granted for this byte-bound command only.",
    });
  });

  it("requires the final human decision for execve approvals even with auto-review configured", async () => {
    configureExecReviewer(params);
    reviewExec.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "read-only version check",
      risk: "low",
    });
    requestApproval.mockResolvedValueOnce({
      id: "plugin:approval-auto-review",
      decision: "allow-always",
    });
    waitForApproval.mockResolvedValueOnce({ decision: "deny", terminalReason: undefined });
    const result = await approve({
      approvalId: "execve-approval-1",
      availableDecisions: ["accept", "cancel"],
      command: "node --version",
    });
    expect(result).toEqual({ decision: "decline" });
    expect(reviewExec).not.toHaveBeenCalled();
    expectHumanApproval();
    approvalEvent(params, { status: "denied", approvalId: "plugin:approval-auto-review" });
  });

  it("keeps commandless managed-network approvals on the human route in full-auto", async () => {
    mockApprovalDecision("plugin:approval-network", "allow-once");
    const result = await approve(
      {
        networkApprovalContext: { host: "example.test", protocol: "https" },
      },
      { autoApprove: true },
    );
    expect(result).toEqual({ decision: "accept" });
    expect(reviewExec).not.toHaveBeenCalled();
    expectHumanApproval();
    expect(gatewayRequestPayload()).toMatchObject({
      title: "Codex app-server network approval",
      description: "Network: https://example.test",
      toolName: "codex_network_approval",
    });
    expectPolicy({
      toolName: "codex_network_approval",
      params: expect.objectContaining({
        approval: expect.objectContaining({
          networkApprovalContext: { host: "example.test", protocol: "https" },
        }),
      }),
    });
  });

  it("passes the exact native command cwd to the host policy capability", async () => {
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
    const result = await approve({
      command: "pwd",
      cwd: "/native/action/worktree",
    });
    expect(result).toEqual({ decision: "decline" });
    expect(runBeforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ nativeOperation: { cwd: "/native/action/worktree" } }),
    );
    expectNoHumanApproval();
  });

  it.each([
    [
      JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "blocked by native relay",
        },
      }),
      "",
      0,
      "blocked by native relay",
    ],
    [
      "not-json",
      "",
      0,
      "OpenClaw native hook relay returned an unreadable Codex app-server approval result.",
    ],
    [
      JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }),
      "",
      0,
      "OpenClaw native hook relay returned a non-deny Codex app-server approval decision.",
    ],
    ["ignored stdout", "blocked from stderr", 1, "blocked from stderr"],
  ] as const)(
    "fails closed before prompting for relay output %s",
    async (stdout, stderr, exitCode, message) => {
      invokeRelay.mockResolvedValueOnce({ stdout, stderr, exitCode });
      const requestParams = {
        ...codexTestTurnIds(),
        command: "cat /tmp/private_key",
        cwd: "/workspace",
      };
      const result = await approve(requestParams, {
        autoApprove: true,
        nativeHookRelay,
      });
      expect(result).toEqual({ decision: "decline" });
      expect(beforeToolCall).not.toHaveBeenCalled();
      expectNoHumanApproval();
      expect(invokeRelay).toHaveBeenCalledExactlyOnceWith({
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_use_id: "cmd",
          tool_name: "exec_command",
          openclaw_approval_mode: "report",
          cwd: "/workspace",
          turn_id: "turn-1",
          tool_input: {
            command: requestParams.command,
            cwd: "/workspace",
            approval: { itemId: "cmd", ...requestParams },
            cmd: requestParams.command,
          },
        },
        requireGeneration: true,
      });
      approvalEvent(params, { status: "denied", message });
    },
  );

  it.each(["invocation", "deferred"] as const)(
    "fails closed when host authority closes during native relay %s",
    async (phase) => {
      let active = true;
      params.hostCapabilities = {
        ...params.hostCapabilities,
        assertActive: () => {
          if (!active) {
            throw new Error("agent harness host capability is no longer active");
          }
        },
      };
      hasRelayInvocation.mockReturnValueOnce(phase === "deferred").mockReturnValueOnce(true);
      invokeRelay.mockImplementationOnce(async () => {
        active = false;
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      resolveDeferred.mockImplementationOnce(async () => {
        active = false;
        return { handled: true, outcome: "approved-once" };
      });
      const result = await approve(
        { command: "git status" },
        { autoApprove: true, nativeHookRelay },
      );
      expect(result).toEqual({ decision: "decline" });
      expect(beforeToolCall).not.toHaveBeenCalled();
      expectNoHumanApproval();
      approvalEvent(params, { status: phase === "invocation" ? "denied" : "unavailable" });
    },
  );

  it("correlates distinct execve approvals by approvalId instead of parent itemId", async () => {
    const seenToolUseIds = new Set<string>();
    hasRelayInvocation.mockImplementation(({ toolUseId }) =>
      toolUseId ? seenToolUseIds.has(toolUseId) : false,
    );
    invokeRelay.mockImplementation(async ({ rawPayload }) => {
      const toolUseId = requireRecord(rawPayload, "native relay payload").tool_use_id;
      if (typeof toolUseId === "string") {
        seenToolUseIds.add(toolUseId);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    mockApprovalDecision("plugin:approval-execve-1", "allow-once");
    mockApprovalDecision("plugin:approval-execve-2", "allow-once");

    for (const [approvalId, command] of [
      ["execve-approval-1", "git status"],
      ["execve-approval-2", "rm -rf /tmp/work"],
    ] as const) {
      const result = await approve(
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
    expect(beforeToolCall).not.toHaveBeenCalled();
    approvalEvent(params, { status: "pending", approvalId: "plugin:approval-execve-2" });
    approvalEvent(params, { status: "approved", approvalId: "plugin:approval-execve-2" });
    expect(
      invokeRelay.mock.calls.map(
        ([call]) => requireRecord(call.rawPayload, "native relay payload").tool_use_id,
      ),
    ).toEqual(["execve-approval-1", "execve-approval-2"]);
    expect(hasRelayInvocation.mock.calls.map(([call]) => call.toolUseId)).toEqual([
      "execve-approval-1",
      "execve-approval-2",
    ]);
  });

  it("accepts command approvals from deferred native PreToolUse plugin approvals", async () => {
    hasRelayInvocation.mockReturnValueOnce(true);
    resolveDeferred.mockResolvedValueOnce({
      handled: true,
      outcome: "approved-once",
    });
    const result = await approve(
      {
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      { nativeHookRelay },
    );
    expect(result).toEqual({ decision: "accept" });
    expect(beforeToolCall).not.toHaveBeenCalled();
    expect(invokeRelay).not.toHaveBeenCalled();
    expectNoHumanApproval();
    approvalEvent(params, {
      status: "approved",
      message: "Codex app-server approval granted for this turn.",
    });
  });

  it("preserves a deferred native approval failure for lifecycle projection", async () => {
    const onNativeToolFailureDisposition = vi.fn();
    hasRelayInvocation.mockReturnValueOnce(true);
    resolveDeferred.mockResolvedValueOnce({
      handled: true,
      outcome: "denied",
      reason: "Approval cancelled because the run stopped",
      failureDisposition: "cancelled",
    });
    const result = await approve(
      {
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      { nativeHookRelay, onNativeToolFailureDisposition },
    );
    expect(result).toEqual({ decision: "decline" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("cmd", "cancelled");
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
      invokeRelay.mockRejectedValueOnce(new Error("native hook relay not found"));
      const result = await approve({ command: "pwd" }, { autoApprove, nativeHookRelay });
      expect(result).toEqual({ decision });
      expect(beforeToolCall).toHaveBeenCalledTimes(autoApprove ? 1 : 0);
      expect(invokeRelay).toHaveBeenCalledTimes(1);
      expectNoHumanApproval();
      approvalEvent(params, { status, message });
    },
  );

  it("denies permission grants through the human route even with a native relay", async () => {
    mockApprovalDecision("plugin:permission-approval", "deny");
    const result = await approve(
      {
        permissions: { network: { allowHosts: ["example.com"] } },
      },
      { method: "item/permissions/requestApproval", nativeHookRelay },
    );
    expect(result).toEqual({ permissions: {}, scope: "turn" });
    expect(invokeRelay).not.toHaveBeenCalled();
    expectHumanApproval();
  });

  it("denies command approvals when OpenClaw tool policy rewrites params", async () => {
    beforeToolCall.mockResolvedValueOnce({
      blocked: false,
      params: {
        command: "echo rewritten",
        approval: {
          ...codexTestTurnIds(),
          itemId: "cmd",
          command: "echo rewritten",
        },
      },
    });
    const result = await approve({
      command: "cat /tmp/private_key",
    });
    expect(result).toEqual({ decision: "decline" });
    expectNoHumanApproval();
    approvalEvent(params, {
      status: "denied",
      message:
        "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
    });
  });

  it("keeps OpenClaw plugin allow-always approvals scoped to one Codex request", async () => {
    beforeToolCall.mockResolvedValueOnce({
      blocked: false,
      params: {
        command: "pnpm test",
        approval: { ...codexTestTurnIds(), itemId: "cmd", command: "pnpm test" },
      },
      approvalResolution: "allow-always",
    });
    const result = await approve({
      command: "pnpm test",
    });
    expect(result).toEqual({ decision: "accept" });
    expectNoHumanApproval();
    approvalEvent(params, {
      status: "approved",
      message: "Codex app-server approval granted for this turn.",
    });
  });

  it("preserves a pre-execution failure for native lifecycle projection", async () => {
    const disposition = "failed" as const;
    const onNativeToolFailureDisposition = vi.fn();
    beforeToolCall.mockResolvedValueOnce({
      blocked: true,
      kind: "failure",
      disposition,
      deniedReason: "plugin-before-tool-call",
      reason: "Tool call blocked because before_tool_call hook failed",
    });
    const result = await approve({ command: "pnpm test" }, { onNativeToolFailureDisposition });
    expect(result).toEqual({ decision: "decline" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("cmd", disposition);
  });

  it("describes command approval permission and policy amendments", async () => {
    params = createParams({ prepareMutableFileApproval: noMutableFile });
    mockApprovalDecision("plugin:approval-command-permissions", "allow-always");
    const result = await approve({
      command: "npm install",
      commandActions: [{ command: `${"npm install ".repeat(500)} --unsafe-perm` }],
      additionalPermissions: { fileSystem: { write: ["/"] } },
      proposedExecpolicyAmendment: ["npm install"],
      proposedNetworkPolicyAmendments: [{ host: "registry.npmjs.org", action: "allow" }],
    });
    expect(result).toEqual({ decision: "acceptForSession" });
    expectDescription(
      "Command: npm install",
      "[preview truncated or unsafe content omitted]",
      "Additional permissions: fileSystem",
      "High-risk targets: filesystem root",
      "File system write: /",
      "Proposed exec policy: npm install",
      "Proposed network policy: allow registry.npmjs.org",
    );
    expect(approvalEvent(params, {}).commandPreviewOmitted).toBe(true);
  });

  it("sanitizes parsed command previews without changing the policy command", async () => {
    mockApprovalDecision("plugin:approval-sanitized-command", "allow-once");
    const esc = "\u001b";
    const preview = `pnpm\n${esc}[31mtest${esc}[0m ${esc}]8;;https://example.com${esc}\\VISIBLE${esc}]8;;${esc}\\ safe\u202e hidden\u2069 \ufeffdone\u{e0100} <@U123> [trusted](https://evil) @here`;
    const visible =
      "pnpm test VISIBLE safe hidden done &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here";
    await approve({
      command: "printf safe",
      commandActions: [{ command: preview }],
    });
    expect(gatewayRequestPayload().description).toBe(`Command: ${visible}`);
    expect(beforeToolCall.mock.calls[0]?.[0]).toMatchObject({
      toolName: "exec",
      params: { command: "printf safe" },
    });
    approvalEvent(params, { status: "pending", command: visible });
  });

  it("fails closed when no approval route is available", async () => {
    const onNativeToolFailureDisposition = vi.fn();
    requestApproval.mockResolvedValueOnce({
      id: "plugin:approval-2",
      decision: null,
    });
    const result = await approve(
      {
        reason: "needs write access\nfor \u001b[31m/tmp\u001b[0m\tplease",
      },
      { method: "item/fileChange/requestApproval", onNativeToolFailureDisposition },
    );
    expect(result).toEqual({ decision: "decline" });
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(waitForApproval).not.toHaveBeenCalled();
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("cmd", "failed");
    expect(gatewayRequestPayload().description).toBe("Reason: needs write access for /tmp please");
    approvalEvent(params, {
      status: "unavailable",
      reason: "needs write access for /tmp please",
    });
  });

  it("reports why a command approval could not bind instead of a silent denial", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    const onNativeToolFailureDisposition = vi.fn();
    const reason =
      "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command";
    try {
      const result = await approve(
        { command: "/bin/bash -c 'touch /tmp/openclaw-probe && echo created'" },
        { onNativeToolFailureDisposition },
      );
      expect(result).toEqual({ decision: "decline" });
      expectNoHumanApproval();
      expect(beforeToolCall).not.toHaveBeenCalled();
      expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("cmd", "failed");
      expect(warn).toHaveBeenCalledWith(
        "codex app-server command approval could not bind the command",
        { itemId: "cmd", reason },
      );
      const event = approvalEvent(params, { status: "unavailable" });
      expect(event.message).toContain(reason);
      expect(event.message).toContain("ask an operator");
    } finally {
      warn.mockRestore();
    }
  });

  it("fails closed when waitDecision reports a stale approval id", async () => {
    requestApproval.mockResolvedValueOnce({ id: "plugin:approval-stale" });
    waitForApproval.mockRejectedValueOnce(new Error("approval expired or not found"));
    const result = await approve(
      { reason: "needs write access" },
      { method: "item/fileChange/requestApproval" },
    );
    expect(result).toEqual({ decision: "decline" });
    expectHumanApproval();
    approvalEvent(params, {
      status: "unavailable",
      approvalId: "plugin:approval-stale",
      reason: "needs write access",
      message: "Codex app-server approval unavailable.",
    });
  });

  it("does not classify a matching abort reason as a stale gateway wait", async () => {
    const controller = new AbortController();
    waitForApproval.mockImplementationOnce(() => new Promise(() => {}));

    const pending = waitForPluginApprovalDecision({
      hostCapabilities: createParams().hostCapabilities,
      approvalId: "plugin:approval-abort",
      signal: controller.signal,
    });
    expect(waitForApproval).toHaveBeenCalledOnce();
    controller.abort(new Error("approval expired or not found"));

    await expect(pending).rejects.toThrow("approval expired or not found");
  });

  it("uses the gateway terminal reason as the authoritative approval timeout", async () => {
    const onNativeToolFailureDisposition = vi.fn();
    requestApproval.mockResolvedValueOnce({ id: "plugin:approval-expired" });
    waitForApproval.mockResolvedValueOnce({
      decision: "deny",
      terminalReason: "timeout",
    });
    const result = await approve(
      {
        command: "pnpm test",
        availableDecisions: ["accept", "cancel"],
      },
      { onNativeToolFailureDisposition },
    );
    expect(result).toEqual({ decision: "decline" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("cmd", "timed_out", "command");
    approvalEvent(params, {
      status: "denied",
      approvalId: "plugin:approval-expired",
      message: "Command approval timed out before an operator responded.",
    });
  });

  it("routes unknown approval methods to the human path and still fails closed", async () => {
    mockApprovalDecision("plugin:future-approval", "deny");
    const result = await approve({}, { method: "future/requestApproval" });
    expect(result).toEqual({
      decision: "decline",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    });
    expect(beforeToolCall).not.toHaveBeenCalled();
    expectHumanApproval();
    approvalEvent(params, {
      status: "denied",
      approvalId: "plugin:future-approval",
    });
  });
  it("shows bounded, sanitized permission targets and requires human approval in full-auto", async () => {
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
    const result = await approve(
      { permissions },
      { method: "item/permissions/requestApproval", autoApprove: true },
    );
    expect(result).toEqual({ permissions: expectedPermissions, scope: "turn" });
    expectHumanApproval();
    expectPolicy({ toolName: "codex_permission_approval" });
    const description = String(gatewayRequestPayload().description);
    expect(description.length).toBeLessThanOrEqual(700);
    expectDescription(
      "Network enabled: true; allowHosts: example.com, *.internal (+1 more)",
      "File system read: ~/.ssh/id_rsa; write: /; roots: /tmp/project",
      "entries: read /workspace/project, write /tmp/output (+1 more)",
      "High-risk targets: network access, wildcard hosts, private-network wildcards, filesystem root",
    );
    expect(description).not.toMatch(/secret-token|simone/);
    expect(description).not.toContain("\u009b");
    expect(description).not.toContain("\u001b");
  });

  it("ignores approval requests that are missing explicit thread or turn ids", async () => {
    const result = await handleCodexAppServerApprovalRequest({
      ...codexTestTurnIds(),
      method: "item/commandExecution/requestApproval",
      requestParams: {
        itemId: "cmd",
        command: "pnpm test",
      },
      paramsForRun: params,
    });
    expect(result).toBeUndefined();
    expectNoHumanApproval();
    expect(params.onAgentEvent).not.toHaveBeenCalled();
  });

  it("does not expose split surrogate pairs from the command array preview scan cap", async () => {
    mockApprovalDecision("plugin:approval-utf16-scan", "allow-once");
    await approve({
      command: [`${"\u0000".repeat(4095)}😀tail`],
    });

    const event = approvalEvent(params, { status: "unavailable" });
    expect(event.commandPreviewOmitted).toBe(true);
    expect(event.command).toBeUndefined();
    expectNoHumanApproval();
    expect(() => encodeURIComponent(JSON.stringify(event))).not.toThrow();
  });
});
