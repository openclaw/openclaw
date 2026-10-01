import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import {
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { takeMcpToolApprovalBinding } from "../../infra/mcp-tool-approval-binding.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  closeAdmittedRunDelegatedAuthority,
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  rewrapToolWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
  type InternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import type { AnyAgentTool } from "../tools/common.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import { getInProcessGatewayToolContext } from "../tools/in-process-gateway.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { retainBeforeToolCallForNativeHookRelay } from "./host-private-capabilities.js";

vi.mock("../agent-tools.before-tool-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-tools.before-tool-call.js")>()),
  rewrapToolWithBeforeToolCallHook: vi.fn((tool) => tool),
  runBeforeToolCallHook: vi.fn(async ({ params }) => ({ blocked: false, params })),
}));
vi.mock("../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const mockRewrap = vi.mocked(rewrapToolWithBeforeToolCallHook);
const mockRunBefore = vi.mocked(runBeforeToolCallHook);
const mockCallGatewayTool = vi.mocked(callGatewayTool);
type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

const admissions: PreparedAgentRunAdmission[] = [];

async function admittedAttempt(
  runId = "run-1",
  overrides: Omit<Partial<HostAttempt>, "admittedRunContext" | "runId"> = {},
): Promise<{ attempt: HostAttempt; admission: PreparedAgentRunAdmission }> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${runId}`);
  return {
    admission,
    attempt: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId,
      cwd: "/attempt/worktree",
      workspaceDir: "/workspace",
      currentChannelId: "chat-1",
      messageChannel: "telegram",
      ...overrides,
      admittedRunContext,
    },
  };
}

function testTool(execute = vi.fn(async () => ({ content: [], details: {} }))): {
  tool: AnyAgentTool;
  execute: typeof execute;
} {
  return {
    execute,
    tool: {
      name: "read",
      label: "Read",
      description: "read",
      parameters: Type.Object({}),
      execute,
    },
  };
}

function bindTool(
  attempt: HostAttempt,
  tool: AnyAgentTool,
): {
  host: ReturnType<typeof createAgentHarnessHostCapabilities>;
  bound: AnyAgentTool;
} {
  const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
  const [bound] = host.capabilities.bindToolSurface([tool]);
  if (!bound) {
    throw new Error("expected bound tool");
  }
  return { host, bound };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
});

describe("agent harness host capability", () => {
  it.each([
    { available: undefined, expected: [] },
    { available: false, expected: ["github_identity_status"] },
    { available: true, expected: ["github_identity_status", "github_publish"] },
  ])(
    "captures GitHub availability independently of plugin inputs: $available",
    async ({ available, expected }) => {
      const { attempt } = await admittedAttempt("github-tools", {
        githubPublicationAvailable: available,
      });
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "copilot" });
      attempt.githubPublicationAvailable = available !== true;
      try {
        const tools = host.capabilities.createToolSurface?.({
          githubPublicationAvailable: available !== true,
          config: { tools: { profile: "coding" } },
        });
        expect(
          tools?.filter((tool) => tool.name.startsWith("github_")).map((tool) => tool.name),
        ).toEqual(expected);
      } finally {
        host.close();
      }
    },
  );

  it.each(["restart", "unrelated scope", "user abort"] as const)(
    "preserves the original cancellation when a startup capability closes: %s",
    async (reason) => {
      const work = new AsyncWorkScope();
      const otherWork = new AsyncWorkScope();
      const controller = new AbortController();
      const { attempt } = await admittedAttempt("run-startup-close", {
        abortSignal: controller.signal,
      });
      const context = {} as GatewayRequestContext;
      let current: GatewayRequestContext | undefined = context;
      bindGatewayContextResolver(attempt.admittedRunContext, () => current);
      const host = await work.track(() =>
        createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" }),
      );
      const restart = createAgentRunRestartAbortError();
      try {
        expect(host.capabilities.preparedEnvironment?.()).toBeDefined();
        if (reason === "user abort") {
          controller.abort();
        }
        current = undefined;
        (reason === "unrelated scope" ? otherWork : work).beginClose(restart);
        await otherWork.track(() => {
          expect(() => host.capabilities.preparedEnvironment?.()).toThrow(
            reason === "restart" ? restart : "host capability is no longer active",
          );
        });
      } finally {
        host.close();
        await Promise.all([work.drain(), otherWork.drain()]);
      }
    },
  );

  beforeEach(() => {
    mockRewrap.mockClear();
    mockRunBefore.mockClear();
    mockCallGatewayTool.mockReset();
  });

  it("binds cumulative output usage to its original run and rejects reporting after restart", async () => {
    const onUsage = vi.fn();
    const forgedCallback = vi.fn();
    const { attempt } = await admittedAttempt("run-usage", {
      onAgentEvent: onUsage,
    });
    let host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const events: Array<{ runId: string; sessionKey?: string; outputTokens: unknown }> = [];
    const stop = onAgentEvent((event) => {
      if (event.stream === "usage") {
        events.push({
          runId: event.runId,
          sessionKey: event.sessionKey,
          outputTokens: event.data.outputTokens,
        });
      }
    });
    try {
      host.capabilities.reportOutputTokens?.(12);
      host.close();
      host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      attempt.runId = "forged-run";
      attempt.lifecycleGeneration = "forged-generation";
      attempt.sessionKey = "forged-session";
      attempt.onAgentEvent = forgedCallback;
      host.capabilities.reportOutputTokens?.(8);
      rotateAgentRunRegistryLifecycleGeneration();
      expect(() => host.capabilities.reportOutputTokens?.(100)).toThrow("no longer active");
      expect(events).toEqual([
        { runId: "run-usage", sessionKey: "agent:main:session-1", outputTokens: 12 },
        { runId: "run-usage", sessionKey: "agent:main:session-1", outputTokens: 20 },
      ]);
      expect(onUsage.mock.calls.map(([event]) => event.data.outputTokens)).toEqual([12, 20]);
      expect(forgedCallback).not.toHaveBeenCalled();
    } finally {
      stop();
      host.close();
    }
  });

  it("overwrites plugin policy fields with the host snapshot and revokes lexically", async () => {
    const { attempt, admission } = await admittedAttempt();
    const authority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
    const { tool, execute } = testTool();
    const { host, bound } = bindTool(attempt, tool);
    expect(mockRewrap).toHaveBeenCalledWith(
      tool,
      expect.objectContaining({
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:session-1",
        channelId: "chat-1",
      }),
    );

    const forgedRequest = {
      toolName: "exec",
      params: { command: "true" },
      approvalMode: "deny" as const,
      ctx: { agentId: "forged" },
    };
    // Plain-JavaScript plugins can still supply removed policy fields at runtime.
    await host.capabilities.runBeforeToolCall(
      forgedRequest as unknown as Parameters<typeof host.capabilities.runBeforeToolCall>[0],
    );
    expect(mockRunBefore).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: "request",
        ctx: expect.objectContaining({ agentId: "main", runId: "run-1" }),
      }),
    );

    await host.capabilities.runBeforeToolCall({
      toolName: "exec",
      params: { command: "true" },
      approvalMode: "defer",
    });
    expect(mockRunBefore).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalMode: "defer" }),
    );
    expect(() => host.capabilities.assertActive()).not.toThrow();

    host.close();
    expect(getAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(authority);
    expect(() => host.capabilities.bindToolSurface([tool])).toThrow("no longer active");
    expect(() => host.capabilities.createToolSurface?.({} as never)).toThrow("no longer active");
    expect(() => host.capabilities.assertActive()).toThrow("no longer active");
    await expect(bound.execute("call-1", {})).rejects.toThrow("no longer active");
    expect(execute).not.toHaveBeenCalled();

    admission.close();
    expect(getAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBeUndefined();
  });

  it("keeps policy snapshots independent from later attempt mutation", async () => {
    const config = { tools: { loopDetection: { enabled: true } } };
    const skillsSnapshot = { prompt: "safe", version: 1, skills: [{ name: "safe" }] };
    const { attempt } = await admittedAttempt("run-snapshot", { config, skillsSnapshot });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    config.tools.loopDetection.enabled = false;
    skillsSnapshot.skills[0]!.name = "forged";
    await host.capabilities.runBeforeToolCall({ toolName: "read", params: {} });

    expect(mockRunBefore).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          config: { tools: { loopDetection: { enabled: true } } },
          skillsSnapshot: expect.objectContaining({ skills: [{ name: "safe" }] }),
        }),
      }),
    );
  });

  it("closes prepared mutable-file approval revalidators with the admitted run", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-host-binding-"));
    try {
      fs.writeFileSync(path.join(cwd, "script.sh"), "#!/bin/sh\necho approved\n");
      const { attempt } = await admittedAttempt("run-file-binding", { cwd });
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const prepared = await host.capabilities.prepareMutableFileApproval?.({
        command: "sh script.sh",
        cwd,
      });
      expect(prepared?.ok).toBe(true);
      if (!prepared?.ok) {
        throw new Error("expected mutable file approval binding");
      }

      host.close();

      await expect(prepared.revalidate()).rejects.toThrow("no longer active");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects retained preparation after the admitted Gateway is replaced", async () => {
    const { attempt } = await admittedAttempt("run-prepared-gateway");
    const admitted = {} as GatewayRequestContext;
    const replacement = {} as GatewayRequestContext;
    let current = admitted;
    bindGatewayContextResolver(attempt.admittedRunContext, () => current);
    const preparedExecute = vi.fn(async () => ({ content: [], details: {} }));
    const tool = attachInternalToolExecutionPreparer(testTool().tool, async () => {
      expect(getInProcessGatewayToolContext()).toBe(admitted);
      return {
        kind: "ready",
        args: {},
        execute: preparedExecute,
        dispose: vi.fn(),
      };
    });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const [bound] = host.capabilities.bindToolSurface([tool]);
    const preparer = bound ? getInternalToolExecutionPreparer(bound) : undefined;
    if (!preparer) {
      throw new Error("expected bound preparer");
    }

    await withPluginRuntimeGatewayRequestScope(
      { context: replacement, isWebchatConnect: () => false },
      async () => {
        const prepared = await preparer({ toolCallId: "prepare", args: {} });
        expect(prepared.kind).toBe("ready");
        current = replacement;
        if (prepared.kind === "ready") {
          await expect(prepared.execute()).rejects.toThrow("no longer active");
        }
      },
    );

    expect(preparedExecute).not.toHaveBeenCalled();
  });

  it("does not stage reply bytes after authority release during a remote read", async () => {
    const readStarted = createDeferred();
    const readResult = createDeferred<Buffer>();
    const readWorkspaceFile = vi.fn(async () => {
      readStarted.resolve();
      return await readResult.promise;
    });
    const { attempt } = await admittedAttempt("run-reply-media");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const prepare = host.capabilities.prepareReplyMedia;
    if (!prepare) {
      throw new Error("expected reply media capability");
    }
    const request = {
      kind: "payload" as const,
      payload: { text: "Artifact ready\nMEDIA:./artifact.txt" },
      readWorkspaceFile,
    };
    const pending = prepare(request);
    const rejected = expect(pending).rejects.toThrow();
    await readStarted.promise;
    closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
    readResult.resolve(Buffer.from("remote artifact"));
    await rejected;
    await expect(prepare(request)).rejects.toThrow();
    expect(readWorkspaceFile).toHaveBeenCalledTimes(1);
    host.close();
  });

  it.each([
    { identity: "native", managed: false, source: "env" as const },
    { identity: "managed", managed: true, source: "store" as const },
  ])(
    "prepares the $source preview scrub for a $identity local Codex host",
    async ({ managed, source }) => {
      const { attempt } = await admittedAttempt(`run-${source}-${managed ? "managed" : "native"}`, {
        config: {
          ...(managed
            ? { tools: { github: { profileId: "ghp_66666666666666666666666666666666" } } }
            : {}),
          gateway: {
            controlUi: {
              github: {
                token: { source, provider: "default", id: "PREVIEW_SERVICE_TOKEN" },
              },
            },
          },
        },
      });
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const environment = host.capabilities.preparedEnvironment?.();

      if (managed) {
        expect(environment?.credentialScrubEnv).toMatchObject({
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
        });
      } else {
        expect(environment?.credentialScrubEnv).not.toHaveProperty("GH_TOKEN");
        expect(environment?.credentialScrubEnv).not.toHaveProperty("GITHUB_TOKEN");
      }
      expect(environment?.credentialScrubEnv).toHaveProperty("PREVIEW_SERVICE_TOKEN", "");
      expect(environment?.managedLocalIdentity).toBe(managed);
      expect(environment?.localIdentityEnv).not.toHaveProperty("PREVIEW_SERVICE_TOKEN");
    },
  );

  it("binds hooks to the native harness cwd instead of the agent workspace", async () => {
    const { attempt } = await admittedAttempt("run-native-cwd", {
      cwd: "/tmp/agent-workspace",
    });
    const { tool } = testTool();
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    host.capabilities.bindToolSurface([tool], { cwd: "/tmp/codex-binding" });

    expect(mockRewrap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: "/tmp/codex-binding" }),
    );
  });

  it("derives a bounded native action cwd without accepting forged host authority", async () => {
    const { attempt } = await admittedAttempt("run-native");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    const forgedRequest = {
      toolName: "exec",
      params: { command: "pwd" },
      nativeOperation: { cwd: " ./native/../action " },
      ctx: { agentId: "forged", cwd: "/forged" },
    };
    await host.capabilities.runBeforeToolCall(forgedRequest);

    expect(mockRunBefore).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          agentId: "main",
          runId: "run-native",
          sessionKey: "agent:main:session-1",
          cwd: "/attempt/worktree/action",
        }),
      }),
    );

    await expect(
      host.capabilities.runBeforeToolCall({
        toolName: "exec",
        params: { command: "pwd" },
        nativeOperation: { cwd: `/${"x".repeat(4096)}` },
      }),
    ).rejects.toThrow("must not exceed 4096 bytes");
    expect(mockRunBefore).toHaveBeenCalledTimes(1);
  });

  it("rejects a deferred policy result after exact authority release", async () => {
    const { attempt } = await admittedAttempt("run-policy-race");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const hookStarted = createDeferred<(() => boolean | void) | undefined>();
    const hookResult = createDeferred<{ blocked: false; params: { command: string } }>();
    mockRunBefore.mockImplementationOnce(async () => {
      hookStarted.resolve(getGatewayToolCallerIdentity()?.receiptAuthority);
      return await hookResult.promise;
    });

    const pending = host.capabilities.runBeforeToolCall({
      toolName: "exec",
      params: { command: "true" },
    });
    const receiptAuthority = await hookStarted.promise;
    expect(receiptAuthority).toEqual(expect.any(Function));
    closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
    expect(receiptAuthority?.()).toBe(false);
    hookResult.resolve({ blocked: false, params: { command: "true" } });
    await expect(pending).rejects.toThrow("no longer active");
  });

  it.each(["replacement", "lifecycle rotation"])(
    "keeps a native policy lease after foreground close but fences %s",
    async (revocation) => {
      const { attempt } = await admittedAttempt("run-retained-policy");
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const delegatedAuthority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
      const retained = retainBeforeToolCallForNativeHookRelay(host.capabilities.runBeforeToolCall);
      mockRunBefore.mockImplementationOnce(async ({ params }) => {
        expect(getGatewayToolCallerIdentity()).toBeUndefined();
        return { blocked: false, params };
      });
      expect(delegatedAuthority).toBeDefined();
      expect(retained).toBeDefined();
      if (!retained) {
        throw new Error("expected retained native policy lease");
      }

      expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
      expect(validateAgentRunDelegatedAuthority(delegatedAuthority!)).toBe(false);
      await expect(
        host.capabilities.runBeforeToolCall({ toolName: "exec", params: { command: "true" } }),
      ).rejects.toThrow("no longer active");
      await expect(
        retained.runBeforeToolCall({ toolName: "exec", params: { command: "true" } }),
      ).resolves.toMatchObject({ blocked: false });

      if (revocation === "replacement") {
        await admittedAttempt("run-retained-policy");
      } else {
        rotateAgentRunRegistryLifecycleGeneration();
      }
      await expect(
        retained.runBeforeToolCall({ toolName: "exec", params: { command: "true" } }),
      ).rejects.toThrow("no longer active");
      retained.release();
    },
  );

  it.each([
    {
      name: "request",
      result: { id: "approval-1", decision: null },
      start: (host: ReturnType<typeof createAgentHarnessHostCapabilities>) =>
        host.capabilities.requestApproval({
          title: "Run command",
          description: "Execute a native command",
          severity: "warning",
          toolName: "exec",
          timeoutMs: 1_000,
        }),
    },
    {
      name: "wait",
      result: { id: "approval-1", decision: "allow-once" as const },
      start: (host: ReturnType<typeof createAgentHarnessHostCapabilities>) =>
        host.capabilities.waitForApproval({ approvalId: "approval-1", timeoutMs: 1_000 }),
    },
  ])("rejects a late approval $name result after admission closes", async (operation) => {
    const { attempt, admission } = await admittedAttempt(`run-approval-race-${operation.name}`);
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const started = createDeferred();
    const result = createDeferred<typeof operation.result>();
    mockCallGatewayTool.mockImplementationOnce(async () => {
      started.resolve();
      return await result.promise;
    });
    const pending = operation.start(host);
    await started.promise;
    admission.close();
    result.resolve(operation.result);
    await expect(pending).rejects.toThrow("no longer active");
  });

  it.each([
    {
      label: "matching timeout",
      response: { id: "approval-1", decision: "deny", terminalReason: "timeout" },
      expected: { decision: "deny", terminalReason: "timeout" },
    },
    {
      label: "misrouted allowance",
      response: { id: "approval-other", decision: "allow-once" },
      expected: undefined,
    },
  ] as const)(
    "binds the gateway $label to the requested approval",
    async ({ response, expected }) => {
      const { attempt } = await admittedAttempt("run-approval-result-binding");
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      mockCallGatewayTool.mockResolvedValueOnce(response);

      await expect(
        host.capabilities.waitForApproval({ approvalId: "approval-1", timeoutMs: 1_000 }),
      ).resolves.toEqual(expected);
    },
  );

  it("carries native-turn closure through policy, approval registration, and decision waits", async () => {
    const { attempt } = await admittedAttempt("run-native-approval-scope");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const turn = new AbortController();
    const scopes: AbortSignal[] = [];
    const captureScope = () => {
      scopes.push(AbortSignal.any([...(getGatewayToolCallerIdentity()?.approvalSignals ?? [])]));
    };
    mockRunBefore.mockImplementationOnce(async ({ params }) => {
      captureScope();
      return { blocked: false, params };
    });
    mockCallGatewayTool.mockImplementation(async () => {
      captureScope();
      return { id: "approval", decision: "allow-once" };
    });
    await host.capabilities.runBeforeToolCall({
      toolName: "exec",
      params: {},
      signal: turn.signal,
    });
    await host.capabilities.requestApproval({
      title: "Run command",
      description: "Native command",
      severity: "warning",
      toolName: "exec",
      timeoutMs: 1_000,
      signal: turn.signal,
    });
    await host.capabilities.waitForApproval({
      approvalId: "approval",
      timeoutMs: 1_000,
      signal: turn.signal,
    });
    expect(scopes).toHaveLength(3);
    turn.abort();
    expect(scopes.every((signal) => signal.aborted)).toBe(true);
    expect(() => host.capabilities.assertActive()).not.toThrow();
    host.close();
  });

  it("hands off MCP persistence proof once without serializing the callback", async () => {
    const { attempt } = await admittedAttempt("mcp-persistence-proof");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const authority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext)!;
    const scope = {
      authority,
      agentId: "main",
      toolCallId: "item-1",
      server: "docs",
      tool: "write_note",
    };
    let active = true;
    let proof: (() => boolean) | undefined;
    mockCallGatewayTool.mockImplementationOnce(async (_method, _opts, payload) => {
      expect(payload).toMatchObject({
        mcpTool: { server: "docs", tool: "write_note" },
        toolCallId: "item-1",
        detail: "Full review evidence",
        policySubject: { pluginKey: "docs", mcpServer: "docs", tool: "write_note" },
      });
      expect(payload).not.toHaveProperty("isMcpToolApprovalActive");
      expect(takeMcpToolApprovalBinding({ ...scope, agentId: "other" })).toBeUndefined();
      proof = takeMcpToolApprovalBinding(scope);
      expect(takeMcpToolApprovalBinding(scope)).toBeUndefined();
      return { id: "approval-1" };
    });
    await host.capabilities.requestApproval({
      title: "MCP approval",
      description: "Write a note",
      detail: "Full review evidence",
      severity: "warning",
      toolName: "codex_mcp_tool_approval",
      toolCallId: "item-1",
      timeoutMs: 1_000,
      mcpTool: { server: "docs", tool: "write_note" },
      isMcpToolApprovalActive: () => active,
      policySubject: { pluginKey: "docs", mcpServer: "docs", tool: "write_note" },
    });
    expect(proof?.()).toBe(true);
    active = false;
    expect(proof?.()).toBe(false);
    active = true;
    host.close();
    expect(proof?.()).toBe(false);
  });

  it.each(["host close", "authority release", "attempt abort"] as const)(
    "rejects in-flight bound tool results after %s",
    async (revocation) => {
      const controller = new AbortController();
      const { attempt } = await admittedAttempt("run-bound-race", {
        abortSignal: controller.signal,
      });
      const started = createDeferred();
      const result = createDeferred<{ content: []; details: Record<string, never> }>();
      const { tool } = testTool(
        vi.fn(async () => {
          started.resolve();
          return await result.promise;
        }),
      );
      const { host, bound } = bindTool(attempt, tool);
      const pending = bound.execute("call-race", {});
      await started.promise;
      if (revocation === "authority release") {
        expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
        result.resolve({ content: [], details: {} });
        await expect(pending).rejects.toThrow("no longer active");
      } else {
        if (revocation === "host close") {
          host.close();
        } else {
          controller.abort();
        }
        await expect(pending).rejects.toThrow("Aborted");
        result.resolve({ content: [], details: {} });
      }
    },
  );

  it("disposes a prepared handle that resolves after host capability closure", async () => {
    const { attempt } = await admittedAttempt("run-preparation-close-race");
    const preparationStarted = createDeferred();
    const preparationResult = createDeferred<Awaited<ReturnType<InternalToolExecutionPreparer>>>();
    const disposed = createDeferred();
    const dispose = vi.fn(() => disposed.resolve());
    const { tool } = testTool();
    attachInternalToolExecutionPreparer(tool, async () => {
      preparationStarted.resolve();
      return await preparationResult.promise;
    });
    const { host, bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    if (!boundPreparer) {
      throw new Error("expected retained bound execution preparer");
    }

    const pending = boundPreparer({ toolCallId: "call-prepare-close-race", args: {} });
    await preparationStarted.promise;
    host.close();

    await expect(pending).rejects.toThrow("Aborted");
    preparationResult.resolve({
      kind: "immediate",
      outcome: { kind: "error", error: new Error("late preparation") },
      dispose,
    });
    await disposed.promise;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("aborts prepared execution when its host capability closes", async () => {
    const { attempt } = await admittedAttempt("run-prepared-close-race");
    const executionStarted = createDeferred();
    const executionResult = createDeferred<{ content: []; details: Record<string, never> }>();
    const { tool } = testTool();
    attachInternalToolExecutionPreparer(tool, async () => ({
      kind: "ready",
      args: {},
      execute: async () => {
        executionStarted.resolve();
        return await executionResult.promise;
      },
      dispose() {},
    }));
    const { host, bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    if (!boundPreparer) {
      throw new Error("expected retained bound execution preparer");
    }
    const prepared = await boundPreparer({ toolCallId: "call-ready-close-race", args: {} });
    if (prepared.kind !== "ready") {
      throw new Error("expected ready execution preparation");
    }

    const pending = prepared.execute();
    await executionStarted.promise;
    host.close();

    await expect(pending).rejects.toThrow("Aborted");
    executionResult.resolve({ content: [], details: {} });
  });

  it("fails closed when constructing a host after admission authority closes", async () => {
    const { attempt, admission } = await admittedAttempt("run-closed-before-host");
    admission.close();

    expect(() => createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" })).toThrow(
      "requires active admitted run authority",
    );
  });

  it("rejects a retained execution preparer before preparation after revocation", async () => {
    const { attempt, admission } = await admittedAttempt("run-prepare-revoked");
    const { tool } = testTool();
    const prepare = vi.fn<InternalToolExecutionPreparer>(async () => ({
      kind: "immediate",
      outcome: { kind: "error", error: new Error("not reached") },
      dispose() {},
    }));
    attachInternalToolExecutionPreparer(tool, prepare);
    const { bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    admission.close();

    await expect(boundPreparer?.({ toolCallId: "call-prepare", args: {} })).rejects.toThrow(
      "no longer active",
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects ready execution when authority closes after preparation", async () => {
    const { attempt, admission } = await admittedAttempt("run-ready-revoked");
    const { tool } = testTool();
    const executePrepared = vi.fn(async () => ({ content: [], details: {} }));
    const prepare = vi.fn<InternalToolExecutionPreparer>(async () => ({
      kind: "ready",
      args: {},
      execute: executePrepared,
      dispose() {},
    }));
    attachInternalToolExecutionPreparer(tool, prepare);
    const { bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    if (!boundPreparer) {
      throw new Error("expected retained bound execution preparer");
    }
    const prepared = await boundPreparer({ toolCallId: "call-ready", args: {} });
    expect(prepared.kind).toBe("ready");
    admission.close();

    if (prepared.kind !== "ready") {
      throw new Error("expected ready execution preparation");
    }
    await expect(prepared.execute()).rejects.toThrow("no longer active");
    expect(executePrepared).not.toHaveBeenCalled();
  });
});
