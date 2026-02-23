import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        // Approval request now carries the decision directly.
        return { decision: "allow-once" };
      }
      if (method === "node.invoke") {
        invokeParams = params;
        return { ok: true };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      ask: "always",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call1", { command: "ls -la" });
    expect(result.details.status).toBe("approval-pending");
    const approvalId = (result.details as { approvalId: string }).approvalId;

    await expect
      .poll(() => (invokeParams as { params?: { runId?: string } } | undefined)?.params?.runId, {
        timeout: 2000,
        interval: 20,
      })
      .toBe(approvalId);
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
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      if (method === "exec.approvals.node.get") {
        return { file: approvalsFile };
      }
      if (method === "node.invoke") {
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
        return { status: "accepted", id: (params as { id?: string })?.id };
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      ask: "on-miss",
      security: "allowlist",
      approvalRunningNoticeMs: 0,
      elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
    });

    const result = await tool.execute("call4", { command: "echo ok", elevated: true });
    expect(result.details.status).toBe("approval-pending");
    await approvalSeen;
    expect(calls).toContain("exec.approval.request");
  });

  it("denies node obfuscated command when approval request times out", async () => {
    vi.mocked(detectCommandObfuscation).mockReturnValue({
      detected: true,
      reasons: ["Content piped directly to shell interpreter"],
      matchedPatterns: ["pipe-to-shell"],
    });

    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return {};
      }
      if (method === "node.invoke") {
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
    await expect.poll(() => calls.filter((call) => call === "node.invoke").length).toBe(0);
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
