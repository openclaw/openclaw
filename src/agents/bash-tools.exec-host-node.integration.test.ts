import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../gateway/agent-runtime-approval-authority.js";
import { createPreparedTestApprovalManager } from "../gateway/exec-approval-manager.test-support.js";
import { createChatRunState } from "../gateway/server-chat-state.js";
import { createExecApprovalHandlers } from "../gateway/server-methods/exec-approval.js";
import {
  createApprovalRuntimeClient,
  requestExecApproval,
  resolveExecApproval,
} from "../gateway/server-methods/exec-approval.test-support.js";
import type { RespondFn } from "../gateway/server-methods/response-types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { applyAllowAlwaysDecision } from "../infra/exec-approvals-allow-always.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { readExecApprovalsSnapshot } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer, ExecAutoReviewTranscript } from "../infra/exec-auto-review.js";
import { buildCwdBoundHashedArgPattern } from "../infra/exec-command-resolution.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import { buildSystemRunApprovalBinding } from "../infra/system-run-approval-binding.js";
import { formatExecCommand } from "../infra/system-run-command.js";
import { handleInvoke } from "../node-host/invoke.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import type { Deferred } from "../shared/deferred.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createOperationalRunInstanceRef } from "./admitted-run-context.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import { resolvePreparedExecEnvironment } from "./bash-tools.exec-request-preparation.js";
import { createExecTool } from "./bash-tools.exec-run.js";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: rpc,
  readGatewayCallOptions: vi.fn(() => ({})),
}));

let state: OpenClawTestState;
let invokeCount: number;
let rawPolicyReadable: boolean;
let legacyPrepare: boolean;
let afterPrepare: () => Promise<void>;
let request: ExecuteNodeHostCommandParams & { workdir: string };
let resolveDecision: (result: { decision: string }) => void;
let decisionEntered: Deferred;
beforeEach(async ({ onTestFinished }) => {
  const previousRegistry = captureActivePluginRegistrySnapshot();
  onTestFinished(() => {
    rollbackStagedPluginRegistry(previousRegistry);
  });
  // A real Gateway already loaded its ingress channel before executing a tool.
  // Keep this node-policy fixture from cold-loading the whole A2A plugin graph.
  stageActivePluginRegistry(
    createTestRegistry([
      { pluginId: "a2a", source: "test", plugin: createChannelTestPluginBase({ id: "a2a" }) },
    ]),
    null,
    "default",
  );
  state = await createOpenClawTestState({ label: "node-exec-policy" });
  await state.writeConfig({});
  saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
  invokeCount = 0;
  rawPolicyReadable = true;
  legacyPrepare = false;
  afterPrepare = async () => {};
  request = {
    command: "/usr/bin/printf node-policy-proof",
    workdir: await fs.realpath(state.root),
    env: {},
    sessionKey: "agent:main:node-proof",
    agentId: "main",
    security: "full",
    ask: "off",
    defaultTimeoutSec: 5,
    approvalRunningNoticeMs: 1000,
    warnings: [],
    turnSourceChannel: "webchat",
  };
  const decision = new Promise<{ decision: string }>((resolve) => {
    resolveDecision = resolve;
  });
  decisionEntered = createDeferred();
  rpc.mockReset().mockImplementation(async (method, _options, params) => {
    if (method === "node.list") {
      return {
        nodes: [
          {
            nodeId: "node-1",
            connected: true,
            platform: "darwin",
            caps: ["system.run.execution-context.v1"],
            commands: ["system.run", "system.run.prepare"],
          },
        ],
      };
    }
    if (method === "exec.approvals.node.get") {
      if (!rawPolicyReadable) {
        throw new Error("missing scope: operator.admin");
      }
      return readExecApprovalsSnapshot();
    }
    if (method === "exec.approval.request") {
      return { id: params.id, expiresAtMs: Date.now() + 60000 };
    }
    if (method === "exec.approval.resolve") {
      return { ok: true };
    }
    if (method === "exec.approval.waitDecision") {
      decisionEntered.resolve();
      return await decision;
    }
    if (method !== "node.invoke") {
      throw new Error(`Unexpected RPC: ${method}`);
    }
    if (params.command === "system.run") {
      invokeCount += 1;
    }
    let response:
      | { ok: boolean; payloadJSON?: string; error?: { code?: string; message?: string } }
      | undefined;
    await handleInvoke(
      {
        id: "invoke-1",
        nodeId: "node-1",
        command: params.command,
        paramsJSON: JSON.stringify(params.params),
      },
      {
        async request<T>(name: string, value?: unknown): Promise<T> {
          if (name === "node.invoke.result") {
            response = value as typeof response;
          }
          return {} as T;
        },
      },
      { current: async () => [] },
    );
    if (!response?.ok) {
      throw Object.assign(new Error(response?.error?.message ?? "Node rejected invocation"), {
        details: { nodeError: response?.error },
      });
    }
    if (params.command === "system.run.prepare") {
      await afterPrepare();
    }
    const payload = JSON.parse(response.payloadJSON ?? "{}");
    if (legacyPrepare && params.command === "system.run.prepare") {
      delete payload.plan.policySnapshot;
    }
    return { payload };
  });
});
afterEach(async () => {
  await state.cleanup();
});

it.each([
  { host: "gateway", surface: "subagent" },
  { host: "node", surface: "dashboard" },
] as const)(
  "preserves child context through $host exec from a $surface session",
  async ({ host, surface }) => {
    const childSessionKey = `agent:main:${surface}:exec-child`;
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { agentId: "main", sessionKey: childSessionKey, storePath },
      {
        sessionId: "exec-child-instance",
        updatedAt: Date.now(),
        spawnDepth: 1,
        spawnedBy: "agent:main:main",
      },
    );
    const tool = createExecTool({
      host,
      node: "node-1",
      security: "full",
      ask: "off",
      notifyOnExit: false,
      channelContext: { sender: { id: "sender-1" }, chat: { id: "chat-1" } },
      allowBackground: false,
      config: { session: { store: storePath } },
      sessionKey: "agent:main:main",
      runSessionKey: childSessionKey,
      notifySessionKey: childSessionKey,
    });
    const result = await tool.execute("child-exec-context", {
      command: `${quoteCliArg(process.execPath)} -e ${quoteCliArg("process.stdout.write(JSON.stringify([process.env.OPENCLAW_SUBAGENT_EXEC, JSON.parse(process.env.OPENCLAW_CHANNEL_CONTEXT || 'null')]))")}`,
      ...(host === "gateway" ? { env: { OPENCLAW_SUBAGENT_EXEC: "0" } } : {}),
      workdir: state.root,
    });
    expect(result.details).toMatchObject({
      status: "completed",
      aggregated: JSON.stringify(["1", { sender: { id: "sender-1" }, chat: { id: "chat-1" } }]),
    });
    if (host === "node") {
      const invocations = rpc.mock.calls.filter(([method]) => method === "node.invoke");
      for (const invocation of invocations) {
        const invoke = invocation[2];
        expect(invoke.params.env).toBeUndefined();
        expect(invoke.params.executionContext).toEqual({
          senderId: "sender-1",
          chatId: "chat-1",
          subagent: true,
        });
      }
    }
  },
);

it("prepares managed GitHub exec with the node's own sanitized environment", async () => {
  const environment = withEnv(
    { GH_TOKEN: "gateway-token", GITHUB_TOKEN: "gateway-fallback", GATEWAY_ONLY: "private" },
    () =>
      resolvePreparedExecEnvironment({
        execParams: { command: request.command },
        host: "node",
        defaultPathPrepend: [],
        credentialScrubEnv: { GH_TOKEN: "", GITHUB_TOKEN: "" },
        localIdentityEnv: {
          GH_CONFIG_DIR: "/gateway/managed-gh",
          GIT_AUTHOR_NAME: "Gateway Author",
        },
        managedLocalIdentity: true,
        warnings: [],
      }),
  );
  await withEnvAsync(
    {
      GH_TOKEN: "node-token",
      GITHUB_TOKEN: "node-fallback",
      GH_CONFIG_DIR: "/node/native-gh",
      GIT_AUTHOR_NAME: "Node Author",
      GATEWAY_ONLY: undefined,
    },
    async () => {
      const result = await executeNodeHostCommand({
        ...request,
        ...environment,
        command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify([process.env.GH_TOKEN, process.env.GITHUB_TOKEN, process.env.GH_CONFIG_DIR, process.env.GIT_AUTHOR_NAME, process.env.GATEWAY_ONLY]))'`,
      });
      expect(result.details).toMatchObject({
        status: "completed",
        aggregated: JSON.stringify([null, null, "/node/native-gh", "Node Author", null]),
      });
    },
  );
  expect(invokeCount).toBe(1);
});

it.each(["GH_TOKEN", "GITHUB_TOKEN"])(
  "rejects explicit %s overrides at both node boundaries even when empty",
  async (key) => {
    for (const value of ["", "explicit-token"]) {
      for (const source of ["env", "pluginEnv"] as const) {
        expect(() =>
          resolvePreparedExecEnvironment({
            execParams: {
              command: request.command,
              ...(source === "env" ? { env: { [key]: value } } : {}),
            },
            ...(source === "pluginEnv" ? { pluginEnv: { [key]: value } } : {}),
            host: "node",
            defaultPathPrepend: [],
            credentialScrubEnv: { GH_TOKEN: "", GITHUB_TOKEN: "" },
            managedLocalIdentity: true,
            warnings: [],
          }),
        ).toThrow(`Environment variable '${key}' is forbidden`);
      }
      for (const command of ["system.run.prepare", "system.run"]) {
        await expect(
          rpc(
            "node.invoke",
            {},
            {
              command,
              params: {
                command: [process.execPath, "--version"],
                security: "full",
                ask: "off",
                env: { [key]: value },
              },
            },
          ),
        ).rejects.toThrow(`blocked override keys: ${key}`);
      }
    }
  },
);

it("auto-reviews an absolute direct command through real node preparation and execution", async () => {
  resolveDecision({ decision: "deny" });
  saveExecApprovals({ version: 1, defaults: { security: "allowlist", ask: "on-miss" } });
  const autoReviewer = vi.fn(async () => ({
    decision: "allow-once" as const,
    risk: "low" as const,
    rationale: "prints fixture output",
  }));
  const result = await executeNodeHostCommand({
    ...request,
    security: "allowlist",
    ask: "on-miss",
    autoReview: true,
    autoReviewer,
  });

  expect(autoReviewer).toHaveBeenCalledOnce();
  expect(autoReviewer).toHaveBeenCalledWith(
    expect.objectContaining({
      argv: ["/usr/bin/printf", "node-policy-proof"],
      host: "node",
    }),
  );
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.waitDecision")).toBe(false);
  expect(result.details).toMatchObject({ status: "completed", aggregated: "node-policy-proof" });
  expect(invokeCount).toBe(1);
});

it("honors a retained policy-owner deny when another agent is permissive", async () => {
  saveExecApprovals({
    version: 1,
    defaults: { security: "full", ask: "off" },
    agents: {
      main: { security: "deny", ask: "off" },
      worker: { security: "full", ask: "off" },
    },
  });
  const autoReviewer = vi.fn(async () => ({
    decision: "allow-once" as const,
    risk: "low" as const,
    rationale: "would allow if called",
  }));

  await expect(
    executeNodeHostCommand({
      ...request,
      agentId: "main",
      sessionKey: "agent:main:node-proof",
      security: "full",
      ask: "off",
      autoReview: true,
      autoReviewer,
    }),
  ).rejects.toThrow("exec denied: host=node security=deny");
  expect(autoReviewer).not.toHaveBeenCalled();
  expect(invokeCount).toBe(0);
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.request")).toBe(false);
});

for (const { policyState, shouldExecute } of [
  { policyState: "unchanged", shouldExecute: true },
  { policyState: "retained-owner-revoked", shouldExecute: false },
] as const) {
  it(`auto-reviews as the active runtime while retaining node policy identity (${policyState})`, async (testContext) => {
    const executionAgentId = "worker";
    const executionSessionKey = "agent:worker:subagent:node-proof";
    const policyAgentId = "main";
    const policySessionKey = "agent:main:node-proof";
    const operationalRunInstance = createOperationalRunInstanceRef("run-routed-node-proof");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const runtimeClient = createApprovalRuntimeClient(
      "conn-routed-node-proof",
      "device-routed-node-proof",
      { agentId: executionAgentId, sessionKey: executionSessionKey },
    );
    if (!runtimeClient?.internal?.agentRuntimeIdentity) {
      throw new Error("Expected approval runtime client identity");
    }
    Object.assign(runtimeClient.internal.agentRuntimeIdentity, {
      operationalRunInstance,
      delegatedAuthority: { kind: "local", ...authority },
    });
    const approvalFixture = await createPreparedTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const approvalHandlers = createExecApprovalHandlers(approvalFixture.manager);
    const approvalContext = {
      getRuntimeConfig: () => ({}),
      broadcast: vi.fn(),
      hasExecApprovalClients: () => true,
      chatRunState: createChatRunState(),
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    };
    const baseRpc = rpc.getMockImplementation();
    if (!baseRpc) {
      throw new Error("Expected node RPC fixture implementation");
    }
    let approvalId: string | undefined;

    try {
      await approvalFixture.run(async () => {
        rpc.mockImplementation(async (method, options, params) => {
          if (method === "exec.approval.request") {
            approvalId = params.id;
            const firstResponse = createDeferred<Parameters<RespondFn>>();
            const pending = approvalFixture.track(
              requestExecApproval({
                handlers: approvalHandlers,
                respond: (...response) => {
                  firstResponse.resolve(response);
                },
                context: approvalContext,
                params,
                client: runtimeClient,
              }),
            );
            const [ok, payload, error] = await Promise.race([
              firstResponse.promise,
              pending.then(() => {
                throw new Error("Exec approval request ended before acceptance");
              }),
            ]);
            if (!ok) {
              throw new Error(error?.message ?? "Exec approval registration failed");
            }
            return payload;
          }
          if (method === "exec.approval.resolve") {
            const respond = vi.fn();
            await resolveExecApproval({
              handlers: approvalHandlers,
              id: params.id,
              decision: params.decision,
              respond,
              context: approvalContext,
              client: runtimeClient,
            });
            const [ok, payload, error] = respond.mock.calls[0] ?? [];
            if (!ok) {
              throw new Error(error?.message ?? "Exec approval resolution failed");
            }
            if (policyState === "retained-owner-revoked") {
              saveExecApprovals({
                version: 1,
                defaults: { security: "full", ask: "off" },
                agents: {
                  [policyAgentId]: { security: "deny", ask: "off" },
                  [executionAgentId]: { security: "full", ask: "off" },
                },
              });
            }
            return payload;
          }
          return await baseRpc(method, options, params);
        });

        saveExecApprovals({ version: 1, defaults: { security: "allowlist", ask: "on-miss" } });
        const autoReviewer = vi.fn(async () => ({
          decision: "allow-once" as const,
          risk: "low" as const,
          rationale: "prints fixture output",
        }));
        const execution = executeNodeHostCommand({
          ...request,
          agentId: policyAgentId,
          sessionKey: policySessionKey,
          security: "allowlist",
          ask: "on-miss",
          autoReview: true,
          autoReviewer,
        });

        if (shouldExecute) {
          expect((await execution).details).toMatchObject({
            status: "completed",
            aggregated: "node-policy-proof",
          });
        } else {
          await expect(execution).rejects.toThrow("exec denied: host=node security=deny");
        }
        expect(invokeCount).toBe(shouldExecute ? 1 : 0);
        if (!approvalId) {
          throw new Error("Expected registered approval id");
        }
        const snapshot = await approvalFixture.manager.getSnapshot(approvalId);
        if (!snapshot?.request.systemRunPlan) {
          throw new Error("Expected retained system.run plan");
        }
        expect(snapshot.request).toMatchObject({
          agentId: executionAgentId,
          sessionKey: executionSessionKey,
          systemRunPlan: {
            agentId: policyAgentId,
            sessionKey: policySessionKey,
          },
          systemRunBinding: buildSystemRunApprovalBinding({
            argv: snapshot.request.systemRunPlan.argv,
            cwd: snapshot.request.systemRunPlan.cwd,
            agentId: policyAgentId,
            sessionKey: policySessionKey,
          }).binding,
        });
        expect(snapshot).toMatchObject({
          decision: "allow-once",
          resolutionSource: "auto-review",
        });
      });
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
    }
  });
}

it.each([
  "printf node-policy-proof",
  "/usr/bin/printf *.txt",
  "/usr/bin/env /usr/bin/printf node-policy-proof",
  "/bin/sh -c '/usr/bin/printf node-policy-proof'",
])("keeps remote unpinned or wrapped %s on the human path", async (command) => {
  saveExecApprovals({ version: 1, defaults: { security: "allowlist", ask: "on-miss" } });
  const autoReviewer = vi.fn(async () => ({
    decision: "allow-once" as const,
    risk: "low" as const,
    rationale: "would allow if called",
  }));
  const warnings: string[] = [];
  const execution = executeNodeHostCommand({
    ...request,
    command,
    security: "allowlist",
    ask: "on-miss",
    autoReview: true,
    autoReviewer,
    warnings,
  });
  const drained = execution.catch(() => undefined);
  try {
    await Promise.race([decisionEntered.promise, execution]);
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(invokeCount).toBe(0);
    expect(warnings).toContain("Exec auto-review skipped: dispatch chain cannot be bound");
    resolveDecision({ decision: "deny" });
    await expect(execution).rejects.toThrow("exec denied: user-denied");
  } finally {
    resolveDecision({ decision: "deny" });
    await drained;
  }
});

it("collects live conversation context only when the node exec tool reaches review", async () => {
  let currentTranscript: ExecAutoReviewTranscript | undefined;
  const reviewTranscript = vi.fn(() => currentTranscript);
  const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
    decision: "deny",
    risk: "low",
    rationale: "The operator requested a different action.",
  }));
  const tool = createExecTool({
    host: "node",
    node: "node-1",
    mode: "auto",
    nodeCwd: request.workdir,
    agentId: request.agentId,
    sessionKey: request.sessionKey,
    safeBins: [],
    autoReviewer,
    reviewTranscript,
  });
  expect(reviewTranscript).not.toHaveBeenCalled();
  afterPrepare = async () => {
    expect(reviewTranscript).not.toHaveBeenCalled();
    currentTranscript = {
      entries: [{ kind: "user", origin: "operator", text: "Inspect the node configuration." }],
      omittedEntries: 0,
      truncated: false,
    };
  };

  const result = await tool.execute("node-live-review-context", { command: request.command });

  expect(reviewTranscript).toHaveBeenCalledTimes(1);
  expect(autoReviewer).toHaveBeenCalledWith(
    expect.objectContaining({ host: "node", transcript: currentTranscript }),
  );
  expect(result.details).toMatchObject({ status: "failed", approvalReviewOutcome: "denied" });
  expect(invokeCount).toBe(0);
});

it("denies caller allowlist/off misses before dispatch to a permissive node", async () => {
  await expect(executeNodeHostCommand({ ...request, security: "allowlist" })).rejects.toThrow(
    "allowlist",
  );
  expect(invokeCount).toBe(0);
});

it.each([
  { channel: "webchat", decision: "allow-once" },
  { channel: "a2a", decision: "allow-always" },
])(
  "keeps $channel node approval $decision inside the originating tool lifetime",
  async ({ channel, decision }) => {
    let completed = false;
    const result = executeNodeHostCommand({
      ...request,
      ask: "on-miss",
      security: "allowlist",
      turnSourceChannel: channel,
    }).finally(() => {
      completed = true;
    });
    await Promise.race([decisionEntered.promise, result]);
    resolveDecision({ decision });
    expect(rpc.mock.calls.some(([method]) => method === "exec.approval.waitDecision")).toBe(true);
    expect(completed).toBe(false);
    expect((await result).details).toMatchObject({
      status: "completed",
      aggregated: "node-policy-proof",
    });
    expect(invokeCount).toBe(1);
  },
);

it("prompts for target ask=always even when the caller is full/off", async () => {
  setRuntimeConfigSnapshot({ tools: { exec: { security: "full", ask: "always" } } });
  const result = executeNodeHostCommand(request);
  await Promise.race([decisionEntered.promise, result]);
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.waitDecision")).toBe(true);
  expect(invokeCount).toBe(0);
  resolveDecision({ decision: "allow-once" });
  expect((await result).details.status).toBe("completed");
});

it("does not dispatch a late A2A approval after cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("originating turn closed");
  const execution = executeNodeHostCommand({
    ...request,
    security: "allowlist",
    ask: "on-miss",
    signal: controller.signal,
    turnSourceChannel: "a2a",
  });
  const drained = execution.catch(() => undefined);
  try {
    await Promise.race([decisionEntered.promise, execution]);
    expect(rpc.mock.calls.some(([method]) => method === "exec.approval.waitDecision")).toBe(true);
    controller.abort(reason);
    resolveDecision({ decision: "allow-once" });
    await expect(execution).rejects.toBe(reason);
    expect(invokeCount).toBe(0);
  } finally {
    controller.abort(reason);
    resolveDecision({ decision: "deny" });
    await drained;
  }
});

it("preserves a target deny introduced while approval was pending", async () => {
  const execution = executeNodeHostCommand({
    ...request,
    security: "allowlist",
    ask: "on-miss",
  });
  await Promise.race([decisionEntered.promise, execution]);
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.waitDecision")).toBe(true);
  setRuntimeConfigSnapshot({ tools: { exec: { security: "deny", ask: "off" } } });
  resolveDecision({ decision: "allow-once" });
  const result = await execution;
  expect(result.details).toMatchObject({ status: "failed", failureKind: "policy-denied" });
  expect(result.content).toEqual([
    expect.objectContaining({
      text: expect.not.stringMatching(/may have executed|request approval/),
    }),
  ]);
});

it("executes full/off through a symlink cwd using the prepared canonical directory", async () => {
  const targetDir = path.join(request.workdir, "target");
  const otherDir = path.join(request.workdir, "other");
  const link = path.join(request.workdir, "link");
  await fs.mkdir(targetDir);
  await fs.mkdir(otherDir);
  await fs.symlink(targetDir, link, "dir");
  afterPrepare = async () => {
    await fs.unlink(link);
    await fs.symlink(otherDir, link, "dir");
  };
  const result = await executeNodeHostCommand({
    ...request,
    command: "/bin/pwd -P",
    workdir: link,
  });
  expect(result.details).toMatchObject({ status: "completed", aggregated: `${targetDir}\n` });
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.request")).toBe(false);
});

it("does not bind a full/off script to approval-time contents", async () => {
  const script = path.join(request.workdir, "script.cjs");
  await fs.writeFile(script, 'process.stdout.write("before")');
  afterPrepare = async () => {
    await fs.writeFile(script, 'process.stdout.write("after")');
  };
  const result = await executeNodeHostCommand({
    ...request,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
  });
  expect(result.details).toMatchObject({ status: "completed", aggregated: "after" });
});

it("prepares direct inline Node only without approval binding", async () => {
  const command = [process.execPath, "-e", 'process.stdout.write("inline")'];
  const params = { command, cwd: request.workdir, security: "full", ask: "off" };
  const prepare = (ask = "off") =>
    rpc("node.invoke", {}, { command: "system.run.prepare", params: { ...params, ask } });
  const result = await prepare();
  expect(result.payload.plan.argv).toEqual(command);
  expect(result.payload.plan.mutableFileOperand).toBeUndefined();
  await expect(prepare("always")).rejects.toThrow("cannot safely bind");
  setRuntimeConfigSnapshot({ tools: { exec: { security: "full", ask: "always" } } });
  await expect(prepare()).rejects.toThrow("cannot safely bind");
  expect(invokeCount).toBe(0);
});

it.each(["caller", "node", "approvals"] as const)(
  "keeps approval cwd binding for restrictive %s policy",
  async (owner) => {
    const link = path.join(request.workdir, "approval-link");
    await fs.symlink(request.workdir, link, "dir");
    if (owner === "node") {
      setRuntimeConfigSnapshot({ tools: { exec: { security: "full", ask: "always" } } });
    } else if (owner === "approvals") {
      saveExecApprovals({ version: 1, defaults: { security: "full", ask: "always" } });
    }
    await expect(
      executeNodeHostCommand({
        ...request,
        workdir: link,
        ...(owner === "caller" ? { ask: "always" as const } : {}),
      }),
    ).rejects.toThrow("working directory without symlink path components");
    expect(invokeCount).toBe(0);
  },
);

it.each(["deny", "ask"] as const)(
  "refuses %s tightening after ordinary preparation",
  async (policy) => {
    afterPrepare = async () => {
      setRuntimeConfigSnapshot({
        tools: {
          exec: {
            security: policy === "deny" ? "deny" : "full",
            ask: policy === "ask" ? "always" : "off",
          },
        },
      });
    };
    const result = await executeNodeHostCommand(request);
    expect(result.details).toMatchObject({ status: "failed", failureKind: "policy-denied" });
  },
);

it("refuses a cwd replaced by a symlink after approval preparation", async () => {
  const approved = path.join(request.workdir, "approved");
  const moved = path.join(request.workdir, "moved");
  await fs.mkdir(approved);
  const execution = executeNodeHostCommand({ ...request, workdir: approved, ask: "always" });
  await Promise.race([decisionEntered.promise, execution]);
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.waitDecision")).toBe(true);
  await fs.rename(approved, moved);
  await fs.symlink(moved, approved, "dir");
  resolveDecision({ decision: "allow-once" });
  const result = await execution;
  expect(result.details).toMatchObject({ status: "failed", failureKind: "policy-denied" });
  expect(result.content).toEqual([
    expect.objectContaining({
      text: expect.stringContaining("working directory without symlink path components"),
    }),
  ]);
});

it("uses prepared node policy without administrator access", async () => {
  rawPolicyReadable = false;
  resolveDecision({ decision: "deny" });
  saveExecApprovals({
    version: 1,
    defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
    agents: {
      main: { allowlist: [{ pattern: "/usr/bin/printf", argPattern: "^node-policy-proof$" }] },
    },
  });

  const result = await executeNodeHostCommand({
    ...request,
    security: "allowlist",
    ask: "on-miss",
  });

  expect(result.details).toMatchObject({ status: "completed", aggregated: "node-policy-proof" });
  expect(invokeCount).toBe(1);
  expect(rpc.mock.calls.some(([method]) => method === "exec.approvals.node.get")).toBe(false);
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.request")).toBe(false);
});

it.each(["empty", "always", "deny"] as const)(
  "keeps prepared %s policy restrictive without fetching raw settings",
  async (mode) => {
    rawPolicyReadable = false;
    resolveDecision({ decision: "deny" });
    saveExecApprovals({
      version: 1,
      defaults: {
        security: mode === "deny" ? "deny" : "allowlist",
        ask: mode === "always" ? "always" : "on-miss",
      },
      agents: { main: { allowlist: mode === "empty" ? [] : [{ pattern: "/usr/bin/printf" }] } },
    });
    await expect(
      executeNodeHostCommand({ ...request, security: "allowlist", ask: "on-miss" }),
    ).rejects.toThrow(/exec denied/);
    expect(invokeCount).toBe(0);
    expect(rpc.mock.calls.some(([method]) => method === "exec.approvals.node.get")).toBe(false);
    expect(rpc.mock.calls.some(([method]) => method === "exec.approval.request")).toBe(
      mode !== "deny",
    );
  },
);

it.each(["hit", "argv-miss", "cwd-miss"] as const)(
  "uses prepared cwd-bound rules for an exact %s",
  async (match) => {
    rawPolicyReadable = false;
    resolveDecision({ decision: "deny" });
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss" },
      agents: {
        main: {
          allowlist: [
            {
              pattern: "/usr/bin/printf",
              source: "allow-always",
              argPattern: buildCwdBoundHashedArgPattern(
                ["/usr/bin/printf", "node-policy-proof"],
                request.workdir,
              ),
            },
          ],
        },
      },
    });
    const other = path.join(request.workdir, "other-cwd");
    await fs.mkdir(other);
    const execution = executeNodeHostCommand({
      ...request,
      security: "allowlist",
      ask: "on-miss",
      ...(match === "argv-miss" ? { command: "/usr/bin/printf changed" } : {}),
      ...(match === "cwd-miss" ? { workdir: other } : {}),
    });
    if (match === "hit") {
      expect((await execution).details).toMatchObject({
        status: "completed",
        aggregated: "node-policy-proof",
      });
      expect(invokeCount).toBe(1);
    } else {
      await expect(execution).rejects.toThrow("user-denied");
      expect(invokeCount).toBe(0);
    }
    expect(rpc.mock.calls.some(([method]) => method === "exec.approvals.node.get")).toBe(false);
  },
);

it.each(["exact-command", "patterns"] as const)(
  "preserves prepared durable %s markers without raw policy access",
  async (kind) => {
    rawPolicyReadable = false;
    resolveDecision({ decision: "deny" });
    const commandText = formatExecCommand(buildNodeShellCommand(request.command, "darwin"));
    const file = applyAllowAlwaysDecision({
      file: { version: 1, defaults: { security: "allowlist", ask: "on-miss" } },
      agentId: "main",
      decision:
        kind === "exact-command"
          ? { kind, commandText }
          : {
              kind,
              commandText,
              patterns: [
                {
                  pattern: "/usr/bin/printf",
                  argPattern: buildCwdBoundHashedArgPattern(
                    ["/usr/bin/printf", "node-policy-proof"],
                    request.workdir,
                  ),
                },
              ],
            },
    });
    if (!file) {
      throw new Error("Expected canonical durable grant");
    }
    saveExecApprovals(file);
    expect(
      (await executeNodeHostCommand({ ...request, security: "allowlist", ask: "on-miss" })).details,
    ).toMatchObject({ status: "completed", aggregated: "node-policy-proof" });
    expect(invokeCount).toBe(1);
    expect(rpc.mock.calls.some(([method]) => method === "exec.approvals.node.get")).toBe(false);
    expect(rpc.mock.calls.some(([method]) => method === "exec.approval.request")).toBe(false);
  },
);

it.each([true, false])("preserves snapshot-absent legacy policy access=%s", async (readable) => {
  legacyPrepare = true;
  rawPolicyReadable = readable;
  resolveDecision({ decision: "deny" });
  saveExecApprovals({
    version: 1,
    defaults: { security: "allowlist", ask: "on-miss" },
    agents: { main: { allowlist: [{ pattern: "/usr/bin/printf" }] } },
  });
  const execution = executeNodeHostCommand({ ...request, security: "allowlist", ask: "on-miss" });
  if (readable) {
    expect((await execution).details.status).toBe("completed");
    expect(invokeCount).toBe(1);
  } else {
    await expect(execution).rejects.toThrow("user-denied");
    expect(invokeCount).toBe(0);
  }
  expect(rpc.mock.calls.some(([method]) => method === "exec.approvals.node.get")).toBe(true);
});

it("does not let prepared allowlist facts survive policy revocation", async () => {
  rawPolicyReadable = false;
  saveExecApprovals({
    version: 1,
    defaults: { security: "allowlist", ask: "on-miss" },
    agents: { main: { allowlist: [{ pattern: "/usr/bin/printf" }] } },
  });
  afterPrepare = async () => {
    saveExecApprovals({ version: 1, defaults: { security: "deny", ask: "off" } });
  };
  await expect(
    executeNodeHostCommand({ ...request, security: "allowlist", ask: "on-miss" }),
  ).rejects.toThrow("security=deny");
  expect(invokeCount).toBe(0);
  expect(rpc.mock.calls.some(([method]) => method === "exec.approvals.node.get")).toBe(false);
});

it("warns only about obsolete prepared rules for the current agent", async () => {
  rawPolicyReadable = false;
  resolveDecision({ decision: "deny" });
  saveExecApprovals({
    version: 1,
    defaults: { security: "allowlist", ask: "on-miss" },
    agents: {
      main: { allowlist: [{ pattern: "/usr/bin/old", source: "allow-always" }] },
      other: { allowlist: [{ pattern: "/usr/bin/unrelated", source: "allow-always" }] },
    },
  });
  const warnings: string[] = [];
  await expect(
    executeNodeHostCommand({ ...request, security: "allowlist", ask: "on-miss", warnings }),
  ).rejects.toThrow("user-denied");
  expect(warnings).toContainEqual(
    expect.stringContaining("1 older generated exec rule is inactive for this agent"),
  );
  expect(warnings.join(" ")).not.toContain("unrelated");
});
