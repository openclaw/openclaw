import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequireRecord } from "../../test/helpers/record.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import {
  loadExecApprovals,
  type ExecApprovalsFile,
  type ExecApprovalsAgent,
} from "../infra/exec-approvals.js";
import { sendMessage } from "../infra/outbound/message.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { buildSystemRunPreparePayload } from "../test-utils/system-run-prepare-payload.js";
import { createExecTool as createExecToolImpl } from "./bash-tools.exec-run.js";
import { callGatewayTool } from "./tools/gateway.js";

const createExecTool = (
  defaults?: Parameters<typeof createExecToolImpl>[0],
): ReturnType<typeof createExecToolImpl> =>
  createExecToolImpl({ agentId: "main", approvalRunningNoticeMs: 0, ...defaults });

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: vi.fn(async () => [
    {
      nodeId: "node-1",
      commands: ["system.run", "system.run.prepare"],
      connected: true,
      platform: "darwin",
    },
  ]),
  resolveNodeIdFromList: vi.fn((nodes: Array<{ nodeId: string }>) => nodes[0]?.nodeId),
}));

vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../utils/message-channel.js", () => {
  const INTERNAL_MESSAGE_CHANNEL = "webchat";
  const normalizeMessageChannel = (raw?: string | null) => {
    const normalized = raw?.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (normalized === "web") {
      return INTERNAL_MESSAGE_CHANNEL;
    }
    return normalized;
  };
  const isGatewayMessageChannel = (value: string) => Boolean(normalizeMessageChannel(value));
  return {
    INTERNAL_MESSAGE_CHANNEL,
    isDeliverableMessageChannel: (value: string) => {
      const channel = normalizeMessageChannel(value);
      return Boolean(channel && channel !== INTERNAL_MESSAGE_CHANNEL && channel !== "tui");
    },
    isGatewayMessageChannel,
    normalizeMessageChannel,
    resolveGatewayMessageChannel: normalizeMessageChannel,
    resolveMessageChannel: (primary?: string | null, fallback?: string | null) =>
      normalizeMessageChannel(primary) ?? normalizeMessageChannel(fallback),
  };
});

vi.mock("../utils/delivery-context.shared.js", () => ({
  normalizeDeliveryContext: (context?: {
    channel?: string | null;
    to?: string | number | null;
    accountId?: string | null;
    threadId?: string | number | null;
  }) => {
    if (!context) {
      return undefined;
    }
    const channel = context.channel?.trim().toLowerCase();
    const to = context.to == null ? undefined : String(context.to).trim();
    const accountId = context.accountId?.trim();
    const threadId = context.threadId == null ? undefined : context.threadId;
    if (!channel && !to && !accountId && threadId == null) {
      return undefined;
    }
    return {
      channel: channel || undefined,
      to: to || undefined,
      accountId: accountId || undefined,
      ...(threadId != null && threadId !== "" ? { threadId } : {}),
    };
  },
}));

vi.mock("../infra/exec-approval-surface.js", () => ({
  describeNativeExecApprovalClientSetup: () => null,
  listNativeExecApprovalClientLabels: () => [],
  resolveExecApprovalInitiatingSurfaceState: (params: {
    channel?: string | null;
    accountId?: string | null;
  }) => {
    const channel = params.channel ?? undefined;
    return {
      kind: "enabled",
      channel,
      channelLabel:
        channel === "tui" ? "terminal UI" : channel === "webchat" ? "Web UI" : "this platform",
      accountId: params.accountId ?? undefined,
    };
  },
  supportsNativeExecApprovalClient: (channel?: string | null) =>
    !channel || channel === "webchat" || channel === "tui",
}));

vi.mock("../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
}));

vi.mock("../process/supervisor/index.js", async () => {
  const { createProcessSupervisor } = await import("../process/supervisor/supervisor.js");
  const nativeSupervisor = createProcessSupervisor();
  afterAll(() => nativeSupervisor.shutdown());
  const stdoutFor = (command: string) => {
    if (command.includes("gog-wrapper")) {
      return '{"events":[]}\n';
    }
    if (command.includes("echo cron-ok")) {
      return "cron-ok\n";
    }
    if (command.includes("echo ok")) {
      return "ok\n";
    }
    return "";
  };
  return {
    getProcessSupervisor: () => ({
      spawn: async (input: SpawnInput) => {
        const command = "argv" in input ? input.argv.join(" ") : "";
        const inlineOutput = ["delayed-ok", "approval-one", "approval-two", "allow-always"].find(
          (value) => command.includes(value),
        );
        // Let the real POSIX shell handle executable quoting; Windows keeps the routing fixture.
        if (inlineOutput && process.platform !== "win32") {
          return nativeSupervisor.spawn(input);
        }
        const stdout = inlineOutput ?? stdoutFor(command);
        if (stdout) {
          input.onStdout?.(stdout);
        }
        return {
          activity: { resultSettled: true, lastOutputAtMs: Date.now() },
          runId: "mock-approval-run",
          startedAtMs: Date.now(),
          stdin: undefined,
          wait: async () => ({
            reason: "exit" as const,
            exitCode: 0,
            exitSignal: null,
            durationMs: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          }),
          cancel: vi.fn(),
        };
      },
      cancel: vi.fn(),
      cancelScope: vi.fn(),
    }),
  };
});

function buildPreparedSystemRunPayload(rawInvokeParams: unknown) {
  const invoke = requireRecord(rawInvokeParams ?? {}, "prepare invoke");
  return buildSystemRunPreparePayload(requireRecord(invoke.params ?? {}, "prepare params"));
}

type GatewayHandlers = Record<string, (params: unknown) => unknown>;
const requireRecord = createRequireRecord("record", "expected-label");
const elevated = { enabled: true, allowed: true, defaultLevel: "ask" } as const;

function policy(
  defaults?: ExecApprovalsFile["defaults"],
  allowlist?: ExecApprovalsAgent["allowlist"],
): ExecApprovalsFile {
  return { version: 1, defaults, agents: allowlist ? { main: { allowlist } } : {} };
}

function mockGateway(handlers: GatewayHandlers = {}) {
  const calls: string[] = [];
  vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
    calls.push(method);
    return handlers[method] ? await handlers[method](params) : { ok: true };
  });
  return calls;
}

function mockApproval(decision: string | null, handlers: GatewayHandlers = {}) {
  return mockGateway({
    "exec.approval.request": (params) => ({
      status: "accepted",
      id: requireRecord(params, "request").id,
    }),
    "exec.approval.waitDecision": () => ({ decision }),
    ...handlers,
  });
}

function prepareOnly(params: unknown) {
  return requireRecord(params, "node invoke").command === "system.run.prepare"
    ? buildPreparedSystemRunPayload(params)
    : { ok: true };
}

function nodeFixture(stdout = "ok", prepare = buildPreparedSystemRunPayload) {
  const runs: Record<string, unknown>[] = [];
  return {
    runs,
    handle: (params: unknown) => {
      const invoke = requireRecord(params, "node invoke");
      if (invoke.command === "system.run.prepare") {
        return prepare(params);
      }
      if (invoke.command === "system.run") {
        runs.push(requireRecord(invoke.params, "system.run params"));
        return { payload: { success: true, stdout } };
      }
      return { ok: true };
    },
  };
}

function getResultText(result: { content: Array<{ type?: string; text?: string }> }) {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function gatewayParams(method: string) {
  return vi
    .mocked(callGatewayTool)
    .mock.calls.filter(([name]) => name === method)
    .map((call) => requireRecord(call[2], `${method} params`));
}

function expectAuthenticatedExecFollowup(record: Record<string, unknown>, sessionKey: string) {
  expect(record.sessionKey).toBe(sessionKey);
  expect(record.message).toEqual(expect.stringContaining("<<<BEGIN_UNTRUSTED_EXEC_OUTPUT>>>"));
  expect(record.internalRuntimeHandoffId).toEqual(expect.any(String));
  expect(String(record.idempotencyKey)).toMatch(/^exec-approval-followup:.+:nonce:/);
  expect(record.inputProvenance).toEqual({
    kind: "inter_session",
    sourceSessionKey: sessionKey,
    sourceTool: "exec_approval_followup",
  });
}

function mockNoRoute(handlers: GatewayHandlers = {}) {
  return mockApproval(null, {
    "exec.approval.request": () => ({ id: "approval-id", decision: null }),
    ...handlers,
  });
}

function expectCronDelivery(host: "gateway" | "node") {
  const [request] = gatewayParams("exec.approval.request");
  expect(request?.suppressDelivery).toBe(host === "node" ? true : undefined);
  expect(request?.deliverToApprovalClientsOnly).toBe(host === "gateway" ? true : undefined);
}

describe("exec approvals", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let tempRoot = "";
  let tempCaseIndex = 0;

  beforeAll(async () => {
    // Detached assertions exercise delivery, not cold loading of the recovery graph.
    await import("./bash-tools.exec-approval-followup.js");
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-approvals-"));
  });

  beforeEach(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    ]);
    const tempDir = path.join(tempRoot, `case-${++tempCaseIndex}`);
    await fs.mkdir(tempDir, { recursive: true });
    setTestEnvValue("HOME", tempDir);
    setTestEnvValue("USERPROFILE", tempDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempDir, ".openclaw"));
    deleteTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR");
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    vi.mocked(callGatewayTool).mockReset();
    vi.mocked(sendMessage).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    closeOpenClawStateDatabaseForTest();
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("reuses approval id as the node runId for an explicit agent follow-up", async () => {
    const node = nodeFixture();
    const followup = createDeferredCore<Record<string, unknown>>();
    mockApproval("allow-once", {
      "node.invoke": node.handle,
      agent: (params) => {
        followup.resolve(requireRecord(params, "agent"));
        return { status: "ok" };
      },
    });
    const tool = createExecTool({
      host: "node",
      ask: "always",
      approvalFollowupMode: "agent",
      sessionKey: "agent:main:main",
    });
    const result = await tool.execute("call1", { command: "ls -la" });
    const details = result.details;
    if (details.status !== "approval-pending") {
      throw new Error("Expected a pending approval");
    }
    const pendingText = getResultText(result);
    expect(pendingText).toContain(`Reply with: /approve ${details.approvalSlug} allow-once|deny`);
    expect(pendingText).toContain(`full ${details.approvalId}`);
    expect(pendingText).toContain("Host: node");
    expect(pendingText).toContain("Node: node-1");
    expect(pendingText).toContain("CWD: (node default)");
    expect(pendingText).toContain("Command:\n```sh\n");
    expect(pendingText).toContain("ls -la");
    expect(pendingText).toContain("Mode: foreground (interactive approvals available).");
    expect(pendingText).not.toContain("Background mode");
    const agent = await followup.promise;
    const run = requireRecord(node.runs[0], "system.run params");
    expect(run.runId).toBe(details.approvalId);
    expect(Object.hasOwn(run, "cwd")).toBe(false);
    expect(run.suppressNotifyOnExit).toBe(true);
    expectAuthenticatedExecFollowup(agent, "agent:main:main");
    expect(String(agent.idempotencyKey)).toContain(details.approvalId);
  });

  it("skips approval when node allowlist is satisfied", async () => {
    const binDir = path.join(tempRoot, `case-${tempCaseIndex}`, "bin");
    await fs.mkdir(binDir);
    const exePath = path.join(binDir, process.platform === "win32" ? "tool.cmd" : "tool");
    await fs.writeFile(exePath, "");
    if (process.platform !== "win32") {
      await fs.chmod(exePath, 0o755);
    }
    const node = nodeFixture();
    const calls = mockGateway({
      "node.invoke": node.handle,
      "exec.approvals.node.get": () => ({
        file: policy({ security: "allowlist", ask: "on-miss", askFallback: "deny" }, [
          { pattern: exePath },
        ]),
      }),
    });
    const tool = createExecTool({
      host: "node",
      security: "allowlist",
      ask: "on-miss",
      allowBackground: false,
    });
    const result = await tool.execute("call2", {
      command: `"${exePath}" --help`,
      workdir: "/Users/vv",
      background: true,
    });
    expect(node.runs).toHaveLength(1);
    expect(node.runs[0]?.cwd).toBe("/Users/vv");
    expect(getResultText(result)).toContain(
      "Warning: continuation options are unavailable; running synchronously.",
    );
    expect(getResultText(result)).toContain("ok");
    expect(result.details.status).toBe("completed");
    expect(calls).toContain("exec.approvals.node.get");
    expect(calls).toContain("node.invoke");
    expect(calls).not.toContain("exec.approval.request");
  });

  it.each(["gateway", "node"] as const)(
    "keeps ask=always prompts for %s runs with durable trust",
    async (host) => {
      const allowlist: ExecApprovalsAgent["allowlist"] = [
        { pattern: process.execPath, source: "allow-always" },
      ];
      if (host === "gateway") {
        saveExecApprovals(
          policy({ security: "full", ask: "always", askFallback: "full" }, allowlist),
        );
      }
      const node = nodeFixture("node-ok");
      mockGateway(
        host === "gateway"
          ? {
              "exec.approval.request": () => ({ status: "accepted", id: "approval-id" }),
              // Detached work must stay pending instead of racing the next policy fixture.
              "exec.approval.waitDecision": () => new Promise<never>(() => {}),
            }
          : {
              "node.invoke": node.handle,
              "exec.approvals.node.get": () => ({ file: policy(undefined, allowlist) }),
            },
      );
      const tool = createExecTool({
        host,
        ask: "always",
        security: "full",
        approvalFollowupMode: "agent",
        allowBackground: false,
      });
      const result = await tool.execute(`call-${host}-durable`, {
        command: `${JSON.stringify(process.execPath)} --version`,
        background: true,
      });
      expect(result.details.status).toBe("approval-pending");
      expect(requireRecord(result.details, "result details").allowedDecisions).toEqual([
        "allow-once",
        "deny",
      ]);
      expect(gatewayParams("exec.approval.request")).toHaveLength(1);
      if (host === "gateway") {
        expect(getResultText(result)).not.toMatch(/process|background|yieldMs|poll/i);
        expect(gatewayParams("exec.approval.request")[0]?.warningText).toBeUndefined();
        expect(getResultText(result)).toContain("Reply with: /approve ");
        expect(getResultText(result)).toContain("allow-once|deny");
        expect(getResultText(result)).not.toContain("allow-once|allow-always|deny");
        expect(getResultText(result)).toContain("Allow Always is unavailable");
      }
    },
  );

  it("reuses gateway allow-always approvals for repeated exact commands", async () => {
    saveExecApprovals(policy({ security: "allowlist", ask: "on-miss", askFallback: "deny" }));
    const calls = mockApproval("allow-always");
    const tool = createExecTool({ host: "gateway", ask: "on-miss", security: "allowlist" });
    const command = "echo allow-always";
    const first = await tool.execute("call-gateway-allow-always-initial", { command });
    expect(first.details.status).toBe("completed");
    expect(getResultText(first)).toContain("allow-always");
    expect(calls).toContain("exec.approval.request");
    expect(calls).toContain("exec.approval.waitDecision");
    expect(
      loadExecApprovals().agents?.main?.allowlist?.some((entry) => entry.source === "allow-always"),
    ).toBe(true);
    calls.length = 0;
    const second = await tool.execute("call-gateway-allow-always-repeat", { command });
    expect(second.details.status).toBe("completed");
    expect(getResultText(second)).toContain("allow-always");
    expect(calls).not.toContain("exec.approval.request");
    expect(calls).not.toContain("exec.approval.waitDecision");
  });

  it("reuses exact-command durable trust for node shell-wrapper reruns", async () => {
    const prepared = buildPreparedSystemRunPayload({
      params: { command: ["/bin/sh", "-lc", "cd ."], cwd: process.cwd() },
    });
    const commandText = prepared.payload.plan.commandText;
    const calls = mockGateway({
      "exec.approvals.node.get": () => ({
        file: policy(undefined, [
          {
            pattern: `=command:${crypto.createHash("sha256").update(commandText).digest("hex").slice(0, 16)}`,
            source: "allow-always",
          },
        ]),
      }),
      "node.invoke": nodeFixture("node-shell-wrapper-ok").handle,
    });
    const tool = createExecTool({ host: "node", ask: "on-miss", security: "allowlist" });
    const result = await tool.execute("call-node-shell-wrapper-durable-allow-always", {
      command: "cd .",
    });
    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("node-shell-wrapper-ok");
    expect(calls).not.toContain("exec.approval.request");
    expect(calls).not.toContain("exec.approval.waitDecision");
  });

  it("delivers an explicitly requested agent follow-up through the original external route", async () => {
    const followup = createDeferredCore<Record<string, unknown>>();
    mockApproval("allow-once", {
      agent: (params) => {
        followup.resolve(requireRecord(params, "agent"));
        return { status: "ok" };
      },
    });
    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      approvalFollowupMode: "agent",
      sessionKey: "agent:main:feishu:channel:123",
      elevated,
      messageProvider: "feishu",
      currentChannelId: "123",
      accountId: "default",
      currentThreadTs: "456",
    });
    const result = await tool.execute("call-gw-followup-feishu", {
      command: "echo ok",
      workdir: process.cwd(),
    });
    expect(result.details.status).toBe("approval-pending");
    const agent = await followup.promise;
    expect(gatewayParams("agent")).toHaveLength(1);
    expectAuthenticatedExecFollowup(agent, "agent:main:feishu:channel:123");
    expect(agent).toMatchObject({
      deliver: true,
      bestEffortDeliver: true,
      channel: "feishu",
      to: "123",
      accountId: "default",
      threadId: "456",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("waits inline for native Discord approval and resumes the same session without a second user turn", async () => {
    const decision = createDeferredCore<{ decision: string }>();
    mockApproval("allow-once", {
      "exec.approval.waitDecision": () => decision.promise,
      agent: () => ({ status: "ok" }),
    });
    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      sessionKey: "agent:main:discord:channel:123",
      elevated,
      messageProvider: "discord",
      currentChannelId: "123",
      accountId: "default",
      currentThreadTs: "456",
    });
    let settled = false;
    const resultPromise = tool.execute("call-gw-followup-discord-delayed", {
      command: "printf delayed-ok",
      workdir: process.cwd(),
    });
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(gatewayParams("agent")).toHaveLength(0);
    decision.resolve({ decision: "allow-once" });
    const result = await resultPromise;
    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("delayed-ok");
    expect(gatewayParams("agent")).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("routes denied approval status through an explicitly requested agent follow-up", async () => {
    const followup = createDeferredCore<Record<string, unknown>>();
    mockApproval("deny", {
      agent: (params) => {
        followup.resolve(requireRecord(params, "agent"));
        return { status: "ok" };
      },
    });
    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      approvalFollowupMode: "agent",
      sessionKey: "agent:main:main",
      elevated,
    });
    const result = await tool.execute("call-gw-followup-deny", {
      command: "echo ok",
      workdir: process.cwd(),
    });
    const details = result.details;
    if (details.status !== "approval-pending") {
      throw new Error("Expected a pending approval");
    }
    const approvalId = details.approvalId;
    expect(approvalId).toBeTypeOf("string");
    const agent = await followup.promise;
    expect(gatewayParams("agent")).toHaveLength(1);
    expect(agent).toMatchObject({
      sessionKey: "agent:main:main",
      deliver: false,
      idempotencyKey: `exec-approval-followup:${approvalId}`,
    });
    expect(agent.message).toContain("An async command did not run.");
    expect(agent.message).toContain(`Exec denied (gateway id=${approvalId}, user-denied): echo ok`);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("requires a separate approval for each elevated command after allow-once", async () => {
    mockApproval("allow-once");
    const tool = createExecTool({ ask: "on-miss", security: "allowlist", elevated });
    const first = await tool.execute("call-seq-1", {
      command: "printf approval-one",
      elevated: true,
    });
    const second = await tool.execute("call-seq-2", {
      command: "printf approval-two",
      elevated: true,
    });
    expect(first.details.status).toBe("completed");
    expect(getResultText(first)).toContain("approval-one");
    expect(second.details.status).toBe("completed");
    expect(getResultText(second)).toContain("approval-two");
    const requests = gatewayParams("exec.approval.request");
    expect(requests.map((request) => request.command)).toEqual([
      "printf approval-one",
      "printf approval-two",
    ]);
    const ids = requests.map((request) => request.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(gatewayParams("exec.approval.waitDecision").map((request) => request.id)).toEqual(ids);
  });

  it("runs a direct skill wrapper command without prompting when the wrapper is allowlisted", async () => {
    if (process.platform === "win32") {
      return;
    }
    const binDir = path.join(tempRoot, `case-${tempCaseIndex}`, "bin");
    const wrapperPath = path.join(binDir, "gog-wrapper");
    await fs.mkdir(binDir);
    await fs.writeFile(wrapperPath, "#!/bin/sh\necho '{\"events\":[]}'\n");
    await fs.chmod(wrapperPath, 0o755);
    saveExecApprovals(
      policy({ security: "allowlist", ask: "off", askFallback: "deny" }, [
        { pattern: await fs.realpath(wrapperPath) },
      ]),
    );
    const calls = mockGateway();
    const tool = createExecTool({ host: "gateway", ask: "off", security: "allowlist" });
    const result = await tool.execute("call-skill-wrapper", {
      command: `${JSON.stringify(wrapperPath)} calendar events primary --today --json`,
      workdir: path.dirname(binDir),
    });
    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain('{"events":[]}');
    expect(calls).not.toContain("exec.approval.request");
  });

  it("denies an allowlisted command with shell expansion without requesting approval", async () => {
    if (process.platform === "win32") {
      return;
    }
    saveExecApprovals(
      policy({ security: "allowlist", ask: "off", askFallback: "deny" }, [
        { pattern: await fs.realpath(process.execPath) },
      ]),
    );
    const calls = mockGateway();
    const tool = createExecTool({ host: "gateway", ask: "off", security: "allowlist" });
    const result = await tool.execute("call-shell-expansion-deny", {
      command: `${JSON.stringify(process.execPath)} --version *.md`,
    });
    expect(result.details.status).toBe("failed");
    expect(getResultText(result)).toContain("ask-fallback-deny: execution-plan-miss");
    expect(calls).not.toContain("exec.approval.request");
    expect(calls).not.toContain("exec.approval.waitDecision");
  });

  it("waits for approval registration before returning approval-pending", async () => {
    const registration = createDeferredCore<unknown>();
    const calls = mockGateway({
      "exec.approval.request": () => registration.promise,
      "exec.approval.waitDecision": () => ({ decision: "deny" }),
    });
    const tool = createExecTool({
      host: "gateway",
      ask: "on-miss",
      security: "allowlist",
      approvalFollowupMode: "agent",
    });
    let settled = false;
    const executePromise = tool.execute("call-registration-gate", { command: "echo register" });
    void executePromise.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    registration.resolve({ status: "accepted", id: "approval-id" });
    const result = await executePromise;
    expect(result.details.status).toBe("approval-pending");
    expect(gatewayParams("exec.approval.request")[0]?.suppressDelivery).toBeUndefined();
    expect(calls[0]).toBe("exec.approval.request");
    expect(calls).toContain("exec.approval.waitDecision");
  });

  it("fails fast when approval registration fails", async () => {
    mockGateway({
      "exec.approval.request": () => {
        throw new Error("gateway offline");
      },
    });
    const tool = createExecTool({ host: "gateway", ask: "on-miss", security: "allowlist" });
    await expect(tool.execute("call-registration-fail", { command: "echo fail" })).rejects.toThrow(
      "Exec approval registration failed",
    );
  });

  it("resolves cron no-route approvals inline when askFallback permits trusted automation", async () => {
    saveExecApprovals(policy({ security: "full", ask: "always", askFallback: "full" }));
    const calls = mockNoRoute();
    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      security: "full",
      trigger: "cron",
    });
    const result = await tool.execute("call-cron-inline-approval", { command: "echo cron-ok" });
    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("cron-ok");
    const request = vi
      .mocked(callGatewayTool)
      .mock.calls.find(([method]) => method === "exec.approval.request");
    expect(requireRecord(request?.[3], "request options").expectFinal).toBe(false);
    expectCronDelivery("gateway");
    expect(calls).not.toContain("exec.approval.waitDecision");
  });

  it("forwards inline cron approval state to node system.run", async () => {
    saveExecApprovals(policy({ security: "full", ask: "always", askFallback: "full" }));
    const preparedPlan = {
      argv: ["/bin/sh", "-lc", "echo cron-node-ok"],
      cwd: null,
      commandText: "/bin/sh -lc 'echo cron-node-ok'",
      commandPreview: "echo cron-node-ok",
      agentId: null,
      sessionKey: null,
      mutableFileOperand: { argvIndex: 2, path: "/tmp/cron-node-ok.sh", sha256: "deadbeef" },
    };
    const node = nodeFixture("cron-node-ok", () => ({ payload: { plan: preparedPlan } }));
    mockNoRoute({ "node.invoke": node.handle });
    const tool = createExecTool({ host: "node", ask: "always", security: "full", trigger: "cron" });
    const result = await tool.execute("call-cron-inline-node-approval", {
      command: "echo cron-node-ok",
    });
    expect(result.details.status).toBe("completed");
    expect(getResultText(result)).toContain("cron-node-ok");
    expectCronDelivery("node");
    const params = requireRecord(node.runs[0], "system.run params");
    expect(params.approved).toBeUndefined();
    expect(params.approvalDecision).toBeUndefined();
    expect(params.approvalSource).toBe("ask-fallback");
    expect(params.systemRunPlan).toStrictEqual(preparedPlan);
    expect(params.runId).toBeTypeOf("string");
  });

  it.each(["gateway", "node"] as const)(
    "denies %s cron no-route approvals when askFallback is deny",
    async (host) => {
      saveExecApprovals(policy({ security: "full", ask: "always", askFallback: "deny" }));
      mockNoRoute(
        host === "node"
          ? {
              "node.invoke": prepareOnly,
            }
          : {},
      );
      const tool = createExecTool({ host, ask: "always", security: "full", trigger: "cron" });
      await expect(
        tool.execute(`call-cron-${host}-denied`, { command: `echo cron-${host}-denied` }),
      ).rejects.toThrow("Automation runs cannot wait for interactive exec approval");
      expectCronDelivery(host);
      if (host === "node") {
        expect(gatewayParams("node.invoke").some((invoke) => invoke.command === "system.run")).toBe(
          false,
        );
      }
    },
  );
});
