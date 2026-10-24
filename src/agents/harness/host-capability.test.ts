import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareSessionSourceAuthority } from "../../config/sessions/session-source-authority.js";
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
} from "../admitted-run-context.js";
import {
  rewrapToolWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import * as agentTools from "../agent-tools.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
  type InternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import type { AnyAgentTool } from "../tools/common.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import { getInProcessGatewayToolContext } from "../tools/in-process-gateway.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import {
  admissionFixture,
  bindTool,
  testTool,
  workspaceDefaults,
} from "./host-capability.shard.test-support.js";
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
const { admittedAttempt, closeAdmissions } = admissionFixture(workspaceDefaults);
const hosts: ReturnType<typeof createAgentHarnessHostCapabilities>[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createHost(...args: Parameters<typeof admittedAttempt>) {
  const fixture = await admittedAttempt(...args);
  const host = ownHost(fixture.attempt);
  return { ...fixture, host };
}

function ownHost(
  attempt: Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"],
  pluginId = "codex",
) {
  const host = createAgentHarnessHostCapabilities({ attempt, pluginId });
  hosts.push(host);
  return host;
}

function bindPrepared(
  attempt: Parameters<typeof ownHost>[0],
  prepare: InternalToolExecutionPreparer,
) {
  const { tool } = testTool();
  attachInternalToolExecutionPreparer(tool, prepare);
  const { host, bound } = bindTool(attempt, tool);
  hosts.push(host);
  return {
    host,
    prepare: expectDefined(getInternalToolExecutionPreparer(bound), "bound preparer"),
  };
}

function deferredCall<T>() {
  const started = createDeferred();
  const result = createDeferred<T>();
  return {
    started: started.promise,
    resolve: result.resolve,
    call: vi.fn(async () => {
      started.resolve();
      return result.promise;
    }),
  };
}

function ready(
  execute: Extract<
    Awaited<ReturnType<InternalToolExecutionPreparer>>,
    { kind: "ready" }
  >["execute"],
) {
  return { kind: "ready" as const, args: {}, execute, dispose() {} };
}

const toolResult: { content: []; details: Record<string, never> } = { content: [], details: {} };

const execRequest = { toolName: "exec", params: { command: "true" } };
const approvalRequest = {
  title: "Run command",
  description: "Execute a native command",
  severity: "warning" as const,
  toolName: "exec",
  timeoutMs: 1_000,
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const host of hosts.splice(0)) {
    host.close();
  }
  closeAdmissions();
  resetAgentRunRegistryForTest();
});

describe("agent harness host capability", () => {
  it.each([
    "host close",
    "run replacement",
    "recorder replacement",
    "admission release",
    "lifecycle rotation",
  ] as const)(
    "rejects trajectory cleanup after %s before and during a flush",
    async (revocation) => {
      const flushed = createDeferred();
      const recorder = { recordEvent: vi.fn(), flush: vi.fn(() => flushed.promise) };
      const { attempt, admission, host } = await createHost("run-trajectory-cleanup", {
        trajectoryRecorder: recorder,
      });
      const trajectory = host.capabilities.trajectory!;
      const pending = trajectory.flush();
      if (revocation === "host close") {
        host.close();
      } else if (revocation === "run replacement") {
        attempt.admittedRunContext = {
          ...attempt.admittedRunContext,
          operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
        };
      } else if (revocation === "recorder replacement") {
        attempt.trajectoryRecorder = { recordEvent: vi.fn(), flush: vi.fn(async () => {}) };
      } else if (revocation === "admission release") {
        admission.close();
      } else {
        rotateAgentRunRegistryLifecycleGeneration();
      }
      flushed.resolve();
      await expect(pending).rejects.toThrow("no longer active");
      await expect(trajectory.flush()).rejects.toThrow("no longer active");
      expect(recorder.flush).toHaveBeenCalledOnce();
    },
  );

  it("preserves trajectory flush failures", async () => {
    const failure = new Error("trajectory storage unavailable");
    const { host } = await createHost("run-trajectory-failure", {
      trajectoryRecorder: {
        recordEvent: vi.fn(),
        flush: async () => {
          throw failure;
        },
      },
    });
    await expect(host.capabilities.trajectory!.flush()).rejects.toBe(failure);
  });

  it.each(["host close", "authority release"] as const)(
    "rejects an awaited tool surface after %s during construction",
    async (revocation) => {
      const { admission, host } = await createHost("run-tool-construction-race");
      const result = createDeferred<AnyAgentTool[]>();
      using construct = vi
        .spyOn(agentTools, "createOpenClawCodingToolsInternalAsync")
        .mockReturnValueOnce(result.promise);
      const pending = host.capabilities.createToolSurfaceAsync!({});
      expect(construct).toHaveBeenCalledOnce();
      if (revocation === "host close") {
        host.close();
      } else {
        admission.close();
      }
      const { tool } = testTool();
      mockRewrap.mockClear();
      result.resolve([tool]);
      await expect(pending).rejects.toThrow("no longer active");
      expect(mockRewrap).not.toHaveBeenCalled();
    },
  );

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
      const host = ownHost(attempt, "copilot");
      attempt.githubPublicationAvailable = available !== true;
      const inheritedToolAllowlistRef: string[] = [];
      const tools = await host.capabilities.createToolSurfaceAsync!({
        githubPublicationAvailable: available !== true,
        config: { tools: { profile: "coding" } },
        inheritedToolAllowlistRef,
      });
      expect(inheritedToolAllowlistRef.includes("github_publish")).toBe(available !== undefined);
      expect(
        tools?.filter((tool) => tool.name.startsWith("github_")).map((tool) => tool.name),
      ).toEqual(expected);
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
    let host = ownHost(attempt);
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
      host = ownHost(attempt);
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
    const forgedRequest = {
      ...execRequest,
      approvalMode: "deny" as const,
      ctx: { agentId: "forged" },
    };
    // Plain-JavaScript plugins can still supply removed policy fields at runtime.
    await host.capabilities.runBeforeToolCall(
      forgedRequest as unknown as Parameters<typeof host.capabilities.runBeforeToolCall>[0],
    );
    expect(mockRunBefore.mock.lastCall?.[0]).toMatchObject({
      approvalMode: "request",
      ctx: { agentId: "main", runId: "run-1" },
    });

    await host.capabilities.runBeforeToolCall({ ...execRequest, approvalMode: "defer" });
    expect(mockRunBefore.mock.lastCall?.[0].approvalMode).toBe("defer");
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
    const { host } = await createHost("run-snapshot", { config, skillsSnapshot });

    config.tools.loopDetection.enabled = false;
    skillsSnapshot.skills[0]!.name = "forged";
    using createTools = vi
      .spyOn(agentTools, "createOpenClawCodingToolsInternalAsync")
      .mockResolvedValue([]);
    await host.capabilities.createToolSurfaceAsync!({
      skillsSnapshot: { prompt: "remapped", skills: [{ name: "prompt-view" }] },
    });
    expect(createTools.mock.calls[0]?.[0]).toMatchObject({
      skillsSnapshot: { skills: [{ name: "prompt-view" }] },
      pluginExecutionSkillsSnapshot: { skills: [{ name: "safe" }] },
    });
    await host.capabilities.runBeforeToolCall({ toolName: "read", params: {} });

    expect(mockRunBefore.mock.lastCall?.[0].ctx).toMatchObject({
      config: { tools: { loopDetection: { enabled: true } } },
      skillsSnapshot: { skills: [{ name: "safe" }] },
    });
  });

  it("closes prepared mutable-file approval revalidators with the admitted run", async () => {
    const cwd = tempDirs.make("openclaw-host-binding-");
    fs.writeFileSync(path.join(cwd, "script.sh"), "#!/bin/sh\necho approved\n");
    const { host } = await createHost("run-file-binding", { cwd });
    const prepared = await host.capabilities.prepareMutableFileApproval?.({
      command: "sh script.sh",
      cwd,
    });
    if (!prepared?.ok) {
      throw new Error("expected mutable file approval binding");
    }
    host.close();
    await expect(prepared.revalidate()).rejects.toThrow("no longer active");
  });

  it("rejects retained preparation after the admitted Gateway is replaced", async () => {
    const { attempt } = await admittedAttempt("run-prepared-gateway");
    const admitted = {} as GatewayRequestContext;
    const replacement = {} as GatewayRequestContext;
    let current = admitted;
    bindGatewayContextResolver(attempt.admittedRunContext, () => current);
    const preparedExecute = vi.fn(async () => toolResult);
    const { prepare: preparer } = bindPrepared(attempt, async () => {
      expect(getInProcessGatewayToolContext()).toBe(admitted);
      return ready(preparedExecute);
    });

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
    const read = deferredCall<Buffer>();
    const { attempt, host } = await createHost("run-reply-media");
    const prepare = expectDefined(host.capabilities.prepareReplyMedia, "reply media capability");
    const request = {
      kind: "payload" as const,
      payload: { text: "Artifact ready\nMEDIA:./artifact.txt" },
      readWorkspaceFile: read.call,
    };
    const pending = prepare(request);
    const rejected = expect(pending).rejects.toThrow();
    await read.started;
    closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
    read.resolve(Buffer.from("remote artifact"));
    await rejected;
    await expect(prepare(request)).rejects.toThrow();
    expect(read.call).toHaveBeenCalledTimes(1);
  });

  it("derives a bounded native action cwd without accepting forged host authority", async () => {
    const { host } = await createHost("run-native");

    const forgedRequest = {
      toolName: "exec",
      params: { command: "pwd" },
      nativeOperation: { cwd: " ./native/../action " },
      ctx: { agentId: "forged", cwd: "/forged" },
    };
    await host.capabilities.runBeforeToolCall(forgedRequest);

    expect(mockRunBefore.mock.lastCall?.[0]).toMatchObject({
      ctx: {
        agentId: "main",
        runId: "run-native",
        sessionKey: "agent:main:session-1",
        cwd: "/attempt/worktree/action",
      },
    });

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
    const { attempt, host } = await createHost("run-policy-race");
    const hookStarted = createDeferred<(() => boolean | void) | undefined>();
    const hookResult = createDeferred<{ blocked: false; params: { command: string } }>();
    mockRunBefore.mockImplementationOnce(async () => {
      hookStarted.resolve(getGatewayToolCallerIdentity()?.receiptAuthority);
      return await hookResult.promise;
    });

    const pending = host.capabilities.runBeforeToolCall(execRequest);
    const receiptAuthority = await hookStarted.promise;
    closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
    expect(receiptAuthority?.()).toBe(false);
    hookResult.resolve({ blocked: false, params: { command: "true" } });
    await expect(pending).rejects.toThrow("no longer active");
  });

  it.each(["replacement", "lifecycle rotation"])(
    "keeps a native policy lease after foreground close but fences %s",
    async (revocation) => {
      const { attempt, host } = await createHost("run-retained-policy");
      const delegatedAuthority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
      const retained = retainBeforeToolCallForNativeHookRelay(host.capabilities.runBeforeToolCall);
      mockRunBefore.mockImplementationOnce(async ({ params }) => {
        expect(getGatewayToolCallerIdentity()).toBeUndefined();
        return { blocked: false, params };
      });
      if (!retained) {
        throw new Error("expected retained native policy lease");
      }

      expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
      expect(validateAgentRunDelegatedAuthority(delegatedAuthority!)).toBe(false);
      await expect(host.capabilities.runBeforeToolCall(execRequest)).rejects.toThrow(
        "no longer active",
      );
      await expect(retained.runBeforeToolCall(execRequest)).resolves.toMatchObject({
        blocked: false,
      });

      if (revocation === "replacement") {
        await admittedAttempt("run-retained-policy");
      } else {
        rotateAgentRunRegistryLifecycleGeneration();
      }
      await expect(retained.runBeforeToolCall(execRequest)).rejects.toThrow("no longer active");
      retained.release();
    },
  );

  it.each([
    {
      name: "request",
      result: { id: "approval-1", decision: null },
      start: (host: ReturnType<typeof createAgentHarnessHostCapabilities>) =>
        host.capabilities.requestApproval(approvalRequest),
    },
    {
      name: "wait",
      result: { id: "approval-1", decision: "allow-once" as const },
      start: (host: ReturnType<typeof createAgentHarnessHostCapabilities>) =>
        host.capabilities.waitForApproval({ approvalId: "approval-1", timeoutMs: 1_000 }),
    },
  ])("rejects a late approval $name result after admission closes", async (operation) => {
    const { admission, host } = await createHost(`run-approval-race-${operation.name}`);
    const call = deferredCall<typeof operation.result>();
    mockCallGatewayTool.mockImplementationOnce(call.call);
    const pending = operation.start(host);
    await call.started;
    admission.close();
    call.resolve(operation.result);
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
      const { host } = await createHost("run-approval-result-binding");
      mockCallGatewayTool.mockResolvedValueOnce(response);

      await expect(
        host.capabilities.waitForApproval({ approvalId: "approval-1", timeoutMs: 1_000 }),
      ).resolves.toEqual(expected);
    },
  );

  it("carries native-turn closure through policy, approval registration, and decision waits", async () => {
    const { host } = await createHost("run-native-approval-scope");
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
    await host.capabilities.requestApproval({ ...approvalRequest, signal: turn.signal });
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
    const { attempt, host } = await createHost("mcp-persistence-proof");
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
      const call = deferredCall<{ content: []; details: Record<string, never> }>();
      const { tool } = testTool(call.call);
      const { host, bound } = bindTool(attempt, tool);
      const pending = bound.execute("call-race", {});
      await call.started;
      if (revocation === "authority release") {
        expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
        call.resolve(toolResult);
        await expect(pending).rejects.toThrow("no longer active");
      } else {
        if (revocation === "host close") {
          host.close();
        } else {
          controller.abort();
        }
        await expect(pending).rejects.toThrow("Aborted");
        call.resolve(toolResult);
      }
    },
  );

  it("disposes a prepared handle that resolves after host capability closure", async () => {
    const { attempt } = await admittedAttempt("run-preparation-close-race");
    const call = deferredCall<Awaited<ReturnType<InternalToolExecutionPreparer>>>();
    const disposed = createDeferred();
    const dispose = vi.fn(() => disposed.resolve());
    const { host, prepare } = bindPrepared(attempt, call.call);

    const pending = prepare({ toolCallId: "call-prepare-close-race", args: {} });
    await call.started;
    host.close();

    await expect(pending).rejects.toThrow("Aborted");
    call.resolve({
      kind: "immediate",
      outcome: { kind: "error", error: new Error("late preparation") },
      dispose,
    });
    await disposed.promise;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("aborts prepared execution when its host capability closes", async () => {
    const { attempt } = await admittedAttempt("run-prepared-close-race");
    const call = deferredCall<{ content: []; details: Record<string, never> }>();
    const { host, prepare } = bindPrepared(attempt, async () => ready(call.call));
    const prepared = await prepare({ toolCallId: "call-ready-close-race", args: {} });
    if (prepared.kind !== "ready") {
      throw new Error("expected ready execution preparation");
    }

    const pending = prepared.execute();
    await call.started;
    host.close();

    await expect(pending).rejects.toThrow("Aborted");
    call.resolve(toolResult);
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
    const sourcePrepare = vi.fn<InternalToolExecutionPreparer>(async () => ({
      kind: "immediate",
      outcome: { kind: "error", error: new Error("not reached") },
      dispose() {},
    }));
    const { prepare } = bindPrepared(attempt, sourcePrepare);
    admission.close();

    await expect(prepare({ toolCallId: "call-prepare", args: {} })).rejects.toThrow(
      "no longer active",
    );
    expect(sourcePrepare).not.toHaveBeenCalled();
  });

  it("preserves prepared receipt refusal and lexical closure without rereading its source", async () => {
    const { attempt } = await admittedAttempt("prepared-receipt");
    let current = true;
    class PreparedReceipt {
      releases = 0;
      get checks() {
        return [];
      }
      assertCurrent() {
        return current;
      }
      release() {
        this.releases += 1;
      }
    }
    const source = new PreparedReceipt();
    const receipt = Object.assign(
      vi.fn(() => current),
      { prepareSessionSource: async () => source },
    );
    const host = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: attempt.admittedRunContext.operationalRunInstance,
        receiptAuthority: receipt,
      },
      () => ownHost(attempt),
    );
    const prepared = await prepareSessionSourceAuthority(host.capabilities.assertActive);
    try {
      receipt.mockClear();
      expect(() => prepared.assertCurrent()).not.toThrow();
      current = false;
      expect(() => prepared.assertCurrent()).toThrow();
      expect(receipt).not.toHaveBeenCalled();
      current = true;
      host.close();
      expect(() => prepared.assertCurrent()).toThrow("no longer active");
    } finally {
      await prepared.release?.();
    }
    expect(source.releases).toBe(1);
  });
});
