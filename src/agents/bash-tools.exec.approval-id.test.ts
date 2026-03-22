import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../config/config.js";
import { buildSystemRunPreparePayload } from "../test-utils/system-run-prepare-payload.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: vi.fn(async () => [
    { nodeId: "node-1", commands: ["system.run"], platform: "darwin" },
  ]),
  resolveNodeIdFromList: vi.fn((nodes: Array<{ nodeId: string }>) => nodes[0]?.nodeId),
}));

vi.mock("../infra/exec-obfuscation-detect.js", () => ({
  detectCommandObfuscation: vi.fn(() => ({
    detected: false,
    reasons: [],
    matchedPatterns: [],
  })),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let detectCommandObfuscation: typeof import("../infra/exec-obfuscation-detect.js").detectCommandObfuscation;

function buildPreparedSystemRunPayload(rawInvokeParams: unknown) {
  const invoke = (rawInvokeParams ?? {}) as {
    params?: {
      command?: unknown;
      rawCommand?: unknown;
      cwd?: unknown;
      agentId?: unknown;
      sessionKey?: unknown;
    };
  };
  const params = invoke.params ?? {};
  return buildSystemRunPreparePayload(params);
}

function getTestConfigPath() {
  return path.join(process.env.HOME ?? "", ".openclaw", "openclaw.json");
}

async function writeOpenClawConfig(config: Record<string, unknown>, pretty = false) {
  const configPath = getTestConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, pretty ? 2 : undefined));
}

async function writeExecApprovalsConfig(config: Record<string, unknown>) {
  const approvalsPath = path.join(process.env.HOME ?? "", ".openclaw", "exec-approvals.json");
  await fs.mkdir(path.dirname(approvalsPath), { recursive: true });
  await fs.writeFile(approvalsPath, JSON.stringify(config, null, 2));
}

function acceptedApprovalResponse(params: unknown) {
  return { status: "accepted", id: (params as { id?: string })?.id };
}

function getResultText(result: { content: Array<{ type?: string; text?: string }> }) {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function expectPendingApprovalText(
  result: {
    details: { status?: string };
    content: Array<{ type?: string; text?: string }>;
  },
  options: {
    command: string;
    host: "gateway" | "node";
    nodeId?: string;
    interactive?: boolean;
  },
) {
  expect(result.details.status).toBe("approval-pending");
  const details = result.details as { approvalId: string; approvalSlug: string };
  const pendingText = getResultText(result);
  expect(pendingText).toContain(
    `Reply with: /approve ${details.approvalSlug} allow-once|allow-always|deny`,
  );
  expect(pendingText).toContain(`full ${details.approvalId}`);
  expect(pendingText).toContain(`Host: ${options.host}`);
  if (options.nodeId) {
    expect(pendingText).toContain(`Node: ${options.nodeId}`);
  }
  expect(pendingText).toContain(`CWD: ${process.cwd()}`);
  expect(pendingText).toContain("Command:\n```sh\n");
  expect(pendingText).toContain(options.command);
  if (options.interactive) {
    expect(pendingText).toContain("Mode: foreground (interactive approvals available).");
    expect(pendingText).toContain("Background mode requires pre-approved policy");
  }
  return details;
}

function expectPendingCommandText(
  result: {
    details: { status?: string };
    content: Array<{ type?: string; text?: string }>;
  },
  command: string,
) {
  expect(result.details.status).toBe("approval-pending");
  const text = getResultText(result);
  expect(text).toContain("Command:\n```sh\n");
  expect(text).toContain(command);
}

function mockGatewayOkCalls(calls: string[]) {
  vi.mocked(callGatewayTool).mockImplementation(async (method) => {
    calls.push(method);
    return { ok: true };
  });
}

function createElevatedAllowlistExecTool() {
  return createExecTool({
    ask: "on-miss",
    security: "allowlist",
    approvalRunningNoticeMs: 0,
    elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
  });
}

async function expectGatewayExecWithoutApproval(options: {
  config: Record<string, unknown>;
  command: string;
  ask?: "always" | "on-miss" | "off";
}) {
  await writeExecApprovalsConfig(options.config);
  const calls: string[] = [];
  mockGatewayOkCalls(calls);

  const tool = createExecTool({
    host: "gateway",
    ask: options.ask,
    security: "full",
    approvalRunningNoticeMs: 0,
  });

  const result = await tool.execute("call-no-approval", { command: options.command });
  expect(result.details.status).toBe("completed");
  expect(calls).not.toContain("exec.approval.request");
  expect(calls).not.toContain("exec.approval.waitDecision");
}

function mockAcceptedApprovalFlow(options: {
  onAgent?: (params: Record<string, unknown>) => void;
  onNodeInvoke?: (params: unknown) => unknown;
}) {
  vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
    if (method === "exec.approval.request") {
      return acceptedApprovalResponse(params);
    }
    if (method === "exec.approval.waitDecision") {
      return { decision: "allow-once" };
    }
    if (method === "agent" && options.onAgent) {
      options.onAgent(params as Record<string, unknown>);
      return { status: "ok" };
    }
    if (method === "node.invoke" && options.onNodeInvoke) {
      return await options.onNodeInvoke(params);
    }
    return { ok: true };
  });
}

function mockPendingApprovalRegistration() {
  vi.mocked(callGatewayTool).mockImplementation(async (method) => {
    if (method === "exec.approval.request") {
      return { status: "accepted", id: "approval-id" };
    }
    if (method === "exec.approval.waitDecision") {
      return { decision: null };
    }
    return { ok: true };
  });
}

function expectApprovalUnavailableText(result: {
  details: { status?: string };
  content: Array<{ type?: string; text?: string }>;
}) {
  expect(result.details.status).toBe("approval-unavailable");
  const text = result.content.find((part) => part.type === "text")?.text ?? "";
  expect(text).not.toContain("/approve");
  expect(text).not.toContain("npm view diver name version description");
  expect(text).not.toContain("Pending command:");
  expect(text).not.toContain("Host:");
  expect(text).not.toContain("CWD:");
  return text;
}

describe("exec approvals", () => {
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeAll(async () => {
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    ({ createExecTool } = await import("./bash-tools.exec.js"));
    ({ detectCommandObfuscation } = await import("../infra/exec-obfuscation-detect.js"));
  });

  beforeEach(async () => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    process.env.HOME = tempDir;
    // Windows uses USERPROFILE for os.homedir()
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    vi.resetAllMocks();
    clearConfigCache();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  });

  it("reuses approval id as the node runId", async () => {
    let invokeParams: unknown;
    let agentParams: unknown;

    mockAcceptedApprovalFlow({
      onAgent: (params) => {
        agentParams = params;
      },
      onNodeInvoke: (params) => {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        if (invoke.command === "system.run") {
          invokeParams = params;
          return { payload: { success: true, stdout: "ok" } };
        }
      },
    });

    const tool = createExecTool({
      host: "node",
      ask: "always",
      approvalRunningNoticeMs: 0,
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", { command: "ls -la" });
    const details = expectPendingApprovalText(result, {
      command: "ls -la",
      host: "node",
      nodeId: "node-1",
      interactive: true,
    });
    const approvalId = details.approvalId;

    await expect
      .poll(() => (invokeParams as { params?: { runId?: string } } | undefined)?.params?.runId, {
        timeout: 2000,
        interval: 20,
      })
      .toBe(approvalId);
    expect(
      (invokeParams as { params?: { suppressNotifyOnExit?: boolean } } | undefined)?.params,
    ).toMatchObject({
      suppressNotifyOnExit: true,
    });
    await expect.poll(() => agentParams, { timeout: 2_000, interval: 20 }).toBeTruthy();
  });

  it("skips approval when node allowlist is satisfied", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-bin-"));
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const exeName = process.platform === "win32" ? "tool.cmd" : "tool";
    const exePath = path.join(binDir, exeName);
    await fs.writeFile(exePath, "");
    if (process.platform !== "win32") {
      await fs.chmod(exePath, 0o755);
    }
    const approvalsFile = {
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {
        main: {
          allowlist: [{ pattern: exePath }],
        },
      },
    };

    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approvals.node.get") {
        return { file: approvalsFile };
      }
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        return { payload: { success: true, stdout: "ok" } };
      }
      // exec.approval.request should NOT be called when allowlist is satisfied
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      ask: "on-miss",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call2", {
      command: `"${exePath}" --help`,
    });
    expect(result.details.status).toBe("completed");
    expect(calls).toContain("exec.approvals.node.get");
    expect(calls).toContain("node.invoke");
    expect(calls).not.toContain("exec.approval.request");
  });

  it("honors ask=off for elevated gateway exec without prompting", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      return { ok: true };
    });

    const tool = createExecTool({
      ask: "off",
      security: "full",
      approvalRunningNoticeMs: 0,
      elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
    });

    const result = await tool.execute("call3", { command: "echo ok", elevated: true });
    expect(result.details.status).toBe("completed");
    expect(calls).not.toContain("exec.approval.request");
  });

  it("uses exec-approvals ask=off to suppress gateway prompts", async () => {
    await expectGatewayExecWithoutApproval({
      config: {
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "full" },
        agents: {
          main: { security: "full", ask: "off", askFallback: "full" },
        },
      },
      command: "echo ok",
      ask: "on-miss",
    });
  });

  it("inherits ask=off from exec-approvals defaults when tool ask is unset", async () => {
    await expectGatewayExecWithoutApproval({
      config: {
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "full" },
        agents: {},
      },
      command: "echo ok",
    });
  });

  it("requires approval for elevated ask when allowlist misses", async () => {
    const calls: string[] = [];
    let resolveApproval: (() => void) | undefined;
    const approvalSeen = new Promise<void>((resolve) => {
      resolveApproval = resolve;
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        resolveApproval?.();
        // Return registration confirmation
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      return { ok: true };
    });

    const tool = createElevatedAllowlistExecTool();

    const result = await tool.execute("call4", { command: "echo ok", elevated: true });
    expectPendingApprovalText(result, { command: "echo ok", host: "gateway" });
    await approvalSeen;
    expect(calls).toContain("exec.approval.request");
    expect(calls).toContain("exec.approval.waitDecision");
  });

  it("starts a direct agent follow-up after approved gateway exec completes", async () => {
    const agentCalls: Array<Record<string, unknown>> = [];

    mockAcceptedApprovalFlow({
      onAgent: (params) => {
        agentCalls.push(params);
      },
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      approvalRunningNoticeMs: 0,
      sessionKey: "agent:main:main",
      elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
    });

    const result = await tool.execute("call-gw-followup", {
      command: "echo ok",
      workdir: process.cwd(),
      gatewayUrl: undefined,
      gatewayToken: undefined,
    });

    expect(result.details.status).toBe("approval-pending");
    await expect.poll(() => agentCalls.length, { timeout: 3_000, interval: 20 }).toBe(1);
    expect(agentCalls[0]).toEqual(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliver: false,
        idempotencyKey: expect.stringContaining("exec-approval-followup:"),
      }),
    );
    expect(typeof agentCalls[0]?.message).toBe("string");
    expect(agentCalls[0]?.message).toContain(
      "An async command the user already approved has completed.",
    );
  });

  it("requires a separate approval for each elevated command after allow-once", async () => {
    const requestCommands: string[] = [];
    const requestIds: string[] = [];
    const waitIds: string[] = [];

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        const request = params as { id?: string; command?: string };
        if (typeof request.command === "string") {
          requestCommands.push(request.command);
        }
        if (typeof request.id === "string") {
          requestIds.push(request.id);
        }
        return acceptedApprovalResponse(request);
      }
      if (method === "exec.approval.waitDecision") {
        const wait = params as { id?: string };
        if (typeof wait.id === "string") {
          waitIds.push(wait.id);
        }
        return { decision: "allow-once" };
      }
      return { ok: true };
    });

    const tool = createElevatedAllowlistExecTool();

    const first = await tool.execute("call-seq-1", {
      command: "npm view diver --json",
      elevated: true,
    });
    const second = await tool.execute("call-seq-2", {
      command: "brew outdated",
      elevated: true,
    });

    expect(first.details.status).toBe("approval-pending");
    expect(second.details.status).toBe("approval-pending");
    expect(requestCommands).toEqual(["npm view diver --json", "brew outdated"]);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(waitIds).toEqual(requestIds);
  });

  it("shows full chained gateway commands in approval-pending message", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return acceptedApprovalResponse(params);
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "on-miss",
      security: "allowlist",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call-chain-gateway", {
      command: "npm view diver --json | jq .name && brew outdated",
    });

    expectPendingCommandText(result, "npm view diver --json | jq .name && brew outdated");
    expect(calls).toContain("exec.approval.request");
  });

  it("shows full chained node commands in approval-pending message", async () => {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      ask: "always",
      security: "full",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call-chain-node", {
      command: "npm view diver --json | jq .name && brew outdated",
    });

    expectPendingCommandText(result, "npm view diver --json | jq .name && brew outdated");
    expect(calls).toContain("exec.approval.request");
  });

  it("waits for approval registration before returning approval-pending", async () => {
    const calls: string[] = [];
    let resolveRegistration: ((value: unknown) => void) | undefined;
    const registrationPromise = new Promise<unknown>((resolve) => {
      resolveRegistration = resolve;
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return await registrationPromise;
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      return { ok: true, id: (params as { id?: string })?.id };
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "on-miss",
      security: "allowlist",
      approvalRunningNoticeMs: 0,
    });

    let settled = false;
    const executePromise = tool.execute("call-registration-gate", { command: "echo register" });
    void executePromise.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveRegistration?.({ status: "accepted", id: "approval-id" });
    const result = await executePromise;
    expect(result.details.status).toBe("approval-pending");
    expect(calls[0]).toBe("exec.approval.request");
    expect(calls).toContain("exec.approval.waitDecision");
  });

  it("fails fast when approval registration fails", async () => {
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      if (method === "exec.approval.request") {
        throw new Error("gateway offline");
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "gateway",
      ask: "on-miss",
      security: "allowlist",
      approvalRunningNoticeMs: 0,
    });

    await expect(tool.execute("call-registration-fail", { command: "echo fail" })).rejects.toThrow(
      "Exec approval registration failed",
    );
  });

  it("returns an unavailable approval message instead of a local /approve prompt when discord exec approvals are disabled", async () => {
    await writeOpenClawConfig({
      channels: {
        discord: {
          enabled: true,
          execApprovals: { enabled: false },
        },
      },
    });

    mockPendingApprovalRegistration();

    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      approvalRunningNoticeMs: 0,
      messageProvider: "discord",
      accountId: "default",
      currentChannelId: "1234567890",
    });

    const result = await tool.execute("call-unavailable", {
      command: "npm view diver name version description",
    });

    const text = expectApprovalUnavailableText(result);
    expect(text).toContain("chat exec approvals are not enabled on Discord");
    expect(text).toContain("Web UI or terminal UI");
  });

  it("tells Telegram users that allowed approvers were DMed when Telegram approvals are disabled but Discord DM approvals are enabled", async () => {
    await writeOpenClawConfig(
      {
        channels: {
          telegram: {
            enabled: true,
            execApprovals: { enabled: false },
          },
          discord: {
            enabled: true,
            execApprovals: { enabled: true, approvers: ["123"], target: "dm" },
          },
        },
      },
      true,
    );

    mockPendingApprovalRegistration();

    const tool = createExecTool({
      host: "gateway",
      ask: "always",
      approvalRunningNoticeMs: 0,
      messageProvider: "telegram",
      accountId: "default",
      currentChannelId: "-1003841603622",
    });

    const result = await tool.execute("call-tg-unavailable", {
      command: "npm view diver name version description",
    });

    const text = expectApprovalUnavailableText(result);
    expect(text).toContain("Approval required. I sent the allowed approvers DMs.");
  });

  it("denies node obfuscated command when approval request times out", async () => {
    vi.mocked(detectCommandObfuscation).mockReturnValue({
      detected: true,
      reasons: ["Content piped directly to shell interpreter"],
      matchedPatterns: ["pipe-to-shell"],
    });

    const calls: string[] = [];
    const nodeInvokeCommands: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return { status: "accepted", id: "approval-id" };
      }
      if (method === "exec.approval.waitDecision") {
        return {};
      }
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command) {
          nodeInvokeCommands.push(invoke.command);
        }
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        return { payload: { success: true, stdout: "should-not-run" } };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      ask: "off",
      security: "full",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call5", { command: "echo hi | sh" });
    expect(result.details.status).toBe("approval-pending");
    await expect.poll(() => nodeInvokeCommands.includes("system.run")).toBe(false);
  });

  it("denies gateway obfuscated command when approval request times out", async () => {
    if (process.platform === "win32") {
      return;
    }

    vi.mocked(detectCommandObfuscation).mockReturnValue({
      detected: true,
      reasons: ["Content piped directly to shell interpreter"],
      matchedPatterns: ["pipe-to-shell"],
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      if (method === "exec.approval.request") {
        return { status: "accepted", id: "approval-id" };
      }
      if (method === "exec.approval.waitDecision") {
        return {};
      }
      return { ok: true };
    });

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-obf-"));
    const markerPath = path.join(tempDir, "ran.txt");
    const tool = createExecTool({
      host: "gateway",
      ask: "off",
      security: "full",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call6", {
      command: `echo touch ${JSON.stringify(markerPath)} | sh`,
    });
    expect(result.details.status).toBe("approval-pending");
    await expect
      .poll(async () => {
        try {
          await fs.access(markerPath);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });
});
